// Package host serves the shared Desktop and Server UI and application API.
package host

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	assets "github.com/minifish-org/pith-desk"
	"github.com/minifish-org/pith-desk/internal/desk"
	"github.com/minifish-org/pith-desk/internal/terminal"
	"github.com/minifish-org/pith-desk/internal/wire"
	"github.com/minifish-org/pith-desk/internal/workspacefs"
)

type Server struct {
	URL        string
	server     *http.Server
	listener   net.Listener
	token      string
	service    *desk.Service
	terminals  *terminal.Manager
	terminalMu sync.Mutex
	operations sync.Mutex // Order committed mutations before handing control to another page.
	picker     func() (string, error)
	files      http.Handler
	index      []byte
	ctx        context.Context
	cancel     context.CancelFunc
	mu         sync.Mutex
	clients    map[chan []byte]struct{}

	appearanceMu      sync.Mutex
	appearanceChanged func(desk.AppearanceMode)
	openFile          func(string) error
	revealFile        func(string) error
	copyText          func(string) error
	copyFile          func(string) error
	exportMarkdown    func(string) error
	saveFile          func(string, io.Reader) error
	saveDiagnostics   func(string) error
	updateStatus      func() wire.UpdateStatus
	updateAction      func(string) error
	completionAction  func(desk.Conversation, desk.Workspace)
	completedRuns     map[string]string
	development       *developmentFrontend
	access            *serverAccess
	preview           *webPreview
	browserOpen       func(string, string, string) error
	browserView       func(wire.BrowserViewInput) error
	browserClose      func(string)
	taskStatusAction  func(TaskStatus)
	taskStatus        TaskStatus
	nativeFileDrop    bool
	titlebarOverlay   bool
	nativeMenuInput   NativeMenuStateInput
	nativeMenuAction  func(desk.State, NativeMenuStateInput)
}

func Start(service *desk.Service, picker func() (string, error), appearanceChanged ...func(desk.AppearanceMode)) (*Server, error) {
	return start(service, picker, nil, appearanceChanged...)
}

func start(service *desk.Service, picker func() (string, error), development *developmentFrontend, appearanceChanged ...func(desk.AppearanceMode)) (*Server, error) {
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	return startListener(service, picker, development, ln, "http://"+ln.Addr().String(), nil, appearanceChanged...)
}

func startListener(service *desk.Service, picker func() (string, error), development *developmentFrontend, ln net.Listener, origin string, access *serverAccess, appearanceChanged ...func(desk.AppearanceMode)) (*Server, error) {
	var key [32]byte
	if _, err := rand.Read(key[:]); err != nil {
		ln.Close()
		return nil, err
	}
	web, err := fs.Sub(assets.Web, "frontend/dist")
	if err != nil {
		ln.Close()
		return nil, err
	}
	index, err := fs.ReadFile(web, "index.html")
	if err != nil {
		ln.Close()
		return nil, fmt.Errorf("build frontend first: %w", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &Server{URL: origin, listener: ln, token: hex.EncodeToString(key[:]), service: service, terminals: terminal.New(), picker: picker, files: http.FileServer(http.FS(web)), index: index, ctx: ctx, cancel: cancel, clients: make(map[chan []byte]struct{}), access: access}
	if access != nil {
		// Server never bootstraps the desktop process-local credential.
		s.token = ""
		go access.expire(ctx)
	}
	s.development = development
	if len(appearanceChanged) > 0 {
		s.appearanceChanged = appearanceChanged[0]
	}
	s.server = &http.Server{Handler: http.HandlerFunc(s.serve), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
	if access != nil {
		s.server.ReadTimeout = 2 * time.Minute
	}
	s.completedRuns = completionBaseline(service.Snapshot())
	go func() { _ = s.server.Serve(ln) }()
	go s.broadcast()
	return s, nil
}

func (s *Server) Close() error {
	s.cancel()
	if s.preview != nil {
		s.preview.close()
	}
	s.terminals.Close()
	s.clearTaskStatusAction()
	s.clearNativeMenuAction()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return s.server.Shutdown(ctx)
}

func (s *Server) snapshot() []byte { data, _ := json.Marshal(s.service.Snapshot()); return data }

func (s *Server) broadcast() {
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-s.service.Changes():
			s.mu.Lock()
			state := s.service.Snapshot()
			s.updateTaskStatusLocked(state)
			s.updateNativeMenuLocked(state)
			data, _ := json.Marshal(state)
			completions := s.newCompletionsLocked(state)
			action := s.completionAction
			preview := s.preview
			for ch := range s.clients {
				select {
				case ch <- data:
				default:
					select {
					case <-ch:
					default:
					}
					ch <- data
				}
			}
			s.mu.Unlock()
			if preview != nil {
				preview.pruneWorkspaces(s.service)
			}
			if action != nil {
				for _, entry := range completions {
					for _, workspace := range state.Workspaces {
						if workspace.ID == entry.WorkspaceID {
							// Native notifications may wait for permission. Keep
							// subsequent state updates flowing to the frontend.
							go action(entry, workspace)
							break
						}
					}
				}
			}
		}
	}
}

func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	socketOrigin := strings.Replace(strings.Replace(s.URL, "https://", "wss://", 1), "http://", "ws://", 1)
	policy := "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' " + socketOrigin + "; img-src 'self' data: blob:; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
	if s.development != nil {
		// Vite injects an inline React Refresh preamble and its HMR client may
		// connect directly to the loopback dev server. Both are development-only
		// capabilities; embedded production assets keep the strict policy.
		devOrigin := s.development.url.String()
		policy = strings.Replace(policy, "script-src 'self';", "script-src 'self' 'unsafe-inline';", 1)
		policy = strings.Replace(policy, "connect-src 'self' "+socketOrigin+";", "connect-src 'self' "+socketOrigin+" "+devOrigin+" "+strings.Replace(devOrigin, "http://", "ws://", 1)+";", 1)
	}
	w.Header().Set("Content-Security-Policy", policy)
	expectedHost := strings.TrimPrefix(strings.TrimPrefix(s.URL, "https://"), "http://")
	if r.Host != expectedHost {
		http.Error(w, "Invalid host", http.StatusForbidden)
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" && origin != s.URL {
		http.Error(w, "Invalid origin", http.StatusForbidden)
		return
	}
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		// Identity proxies return through a cross-site top-level navigation.
		// Only the public Server entry document may cross this boundary.
		serverNavigation := s.access != nil && r.Method == http.MethodGet && r.URL.Path == "/" &&
			r.Header.Get("Sec-Fetch-Mode") == "navigate" && r.Header.Get("Sec-Fetch-Dest") == "document"
		if !serverNavigation {
			http.Error(w, "Cross-site access denied", http.StatusForbidden)
			return
		}
	}
	if s.access != nil {
		w.Header().Set("Cache-Control", "no-store")
		if s.serveAccess(w, r) {
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			if !s.authorizeServer(w, r) {
				return
			}
			lease := r.Context().Value(leaseContextKey{}).(*browserLease)
			ctx, cancel := context.WithCancel(r.Context())
			stop := context.AfterFunc(lease.ctx, cancel)
			defer stop()
			defer cancel()
			r = r.WithContext(ctx)
			// Deduplicate admitted mutations before invoking the common handlers.
			if r.Method == http.MethodPost {
				s.serverMutation(w, r)
				return
			}
		} else if s.development != nil && r.URL.Path == "/__desk_hmr" && !s.authorizeDevelopment(w, r) {
			return
		}
	}
	if !strings.HasPrefix(r.URL.Path, "/api/") {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "Method not allowed", 405)
			return
		}
		if r.URL.Path == "/" {
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			indexBytes := s.index
			if s.development != nil {
				var err error
				indexBytes, err = s.development.index(r.Context())
				if err != nil {
					http.Error(w, "Development frontend unavailable", http.StatusBadGateway)
					return
				}
			}
			index := strings.ReplaceAll(string(indexBytes), "__DESK_TOKEN__", s.token)
			mode, appearance := "desktop", "system"
			if s.access != nil {
				mode = "server"
			} else {
				appearance = string(s.service.Snapshot().Settings.Appearance)
			}
			index = strings.ReplaceAll(index, "__DESK_MODE__", mode)
			index = strings.ReplaceAll(index, "__DESK_APPEARANCE__", appearance)
			s.mu.Lock()
			nativeClipboard := s.copyText != nil && s.copyFile != nil
			nativeFileDrop := s.nativeFileDrop
			nativeMenus := s.nativeMenuAction != nil
			titlebarOverlay := s.titlebarOverlay
			s.mu.Unlock()
			index = strings.ReplaceAll(index, "__DESK_NATIVE_BROWSER__", fmt.Sprint(s.browserOpen != nil))
			index = strings.ReplaceAll(index, "__DESK_NATIVE_CLIPBOARD__", fmt.Sprint(nativeClipboard))
			index = strings.ReplaceAll(index, "__DESK_NATIVE_FILE_DROP__", fmt.Sprint(nativeFileDrop))
			index = strings.ReplaceAll(index, "__DESK_NATIVE_MENUS__", fmt.Sprint(nativeMenus))
			index = strings.ReplaceAll(index, "__DESK_TITLEBAR_OVERLAY__", fmt.Sprint(titlebarOverlay))
			_, _ = w.Write([]byte(index))
			return
		}
		if s.development != nil && s.development.assetPath(r.URL.Path) {
			w.Header().Set("Cache-Control", "no-store")
			s.development.proxy.ServeHTTP(w, r)
			return
		}
		// Only the trusted built assets are served. Workspace files are never web roots.
		if strings.HasPrefix(r.URL.Path, "/assets/") || r.URL.Path == "/icon.png" {
			s.files.ServeHTTP(w, r)
			return
		}
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if (r.URL.Path == "/api/socket" || r.URL.Path == "/api/terminal/socket") && r.Method == http.MethodGet {
		// Browsers cannot set Authorization on a WebSocket handshake. Carry
		// the process-local token in a request subprotocol, never in a URL.
		valid := s.access != nil // Server has already checked its cookie and lease.
		for _, protocol := range strings.Split(r.Header.Get("Sec-WebSocket-Protocol"), ",") {
			protocol = strings.TrimSpace(protocol)
			if subtle.ConstantTimeCompare([]byte(protocol), []byte("bearer."+s.token)) == 1 {
				valid = true
			}
		}
		if !valid {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		if r.URL.Path == "/api/terminal/socket" {
			s.terminalSocket(w, r)
		} else {
			s.socket(w, r)
		}
		return
	}
	if s.access == nil && subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+s.token)) != 1 {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	if r.URL.Path == "/api/events" && r.Method == http.MethodGet {
		s.events(w, r)
		return
	}
	s.serveAPI(w, r)
}

func (s *Server) serveAPI(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.URL.Path == "/api/web-preview/view" && r.Method == http.MethodPost {
		s.setBrowserView(w, r)
		return
	}
	if r.URL.Path == "/api/web-preview" && r.Method == http.MethodPost {
		s.openWebPreview(w, r)
		return
	}
	if r.URL.Path == "/api/web-preview/close" && r.Method == http.MethodPost {
		s.closeWebPreview(w, r)
		return
	}
	if r.URL.Path == "/api/terminal" && r.Method == http.MethodGet {
		s.readTerminal(w, r)
		return
	}
	if s.serveTerminal(w, r) {
		return
	}
	if r.URL.Path == "/api/state" && r.Method == http.MethodGet {
		_, _ = w.Write(s.snapshot())
		return
	}
	if s.serveFeatureRead(w, r) {
		return
	}
	if r.Method != http.MethodPost {
		s.fail(w, "Method not allowed", 405)
		return
	}
	bodyLimit := requestBodyLimit(r.URL.Path)
	r.Body = http.MaxBytesReader(w, r.Body, bodyLimit)
	decode := func(dst any) error {
		d := json.NewDecoder(r.Body)
		d.DisallowUnknownFields()
		return d.Decode(dst)
	}
	var err error
	switch r.URL.Path {
	case "/api/native-menu-state":
		var in NativeMenuStateInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
			err = s.SetNativeMenuState(in)
		}
	case "/api/config":
		var in desk.ConfigInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
			err = s.service.Configure(in)
		}
	case "/api/appearance":
		var in wire.AppearanceInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
			// Serialize persisted changes and the native theme update so two
			// concurrent requests cannot leave the window on an older mode.
			s.appearanceMu.Lock()
			err = s.service.SetAppearance(in.Mode)
			if err == nil && s.appearanceChanged != nil {
				s.appearanceChanged(in.Mode)
			}
			s.appearanceMu.Unlock()
		}
	case "/api/sidebar-widths":
		var in desk.SidebarWidths
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
			err = s.service.SetSidebarWidths(in)
		}
	case "/api/workspaces":
		var in wire.PathInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
			if s.access != nil && !filepath.IsAbs(strings.TrimSpace(in.Path)) {
				s.fail(w, "Enter an absolute directory path on the server.", http.StatusBadRequest)
				return
			}
			if s.access != nil {
				if in.Path, err = workspacefs.ReadableDirectory(in.Path); err != nil {
					s.fail(w, err.Error(), http.StatusBadRequest)
					return
				}
			}
			var workspace desk.Workspace
			workspace, err = s.service.AddWorkspace(in.Path)
			if err == nil {
				wire.WriteJSON(w, r.Method, r.URL.Path, wire.WorkspaceResponse{OK: true, Workspace: workspace})
				return
			}
		}
	case "/api/conversations":
		var in wire.WorkspaceInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
			var conversation desk.Conversation
			conversation, err = s.service.CreateConversation(in.WorkspaceID)
			if err == nil {
				wire.WriteJSON(w, r.Method, r.URL.Path, wire.ConversationResponse{Conversation: conversation})
				return
			}
		}
	case "/api/open":
		var in wire.IDInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
			err = s.service.OpenConversation(in.ID)
		}
	case "/api/read":
		var in wire.ReadInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
			err = s.service.MarkConversationRead(in.ID, in.RunID)
		}
	case "/api/send":
		var in wire.SendInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
			err = s.service.SendConversation(in.ID, in.Text, in.Images...)
		}
	case "/api/abort":
		var in wire.IDInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
			err = s.service.AbortConversation(in.ID)
		}
	case "/api/approval":
		var in wire.ApprovalInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
			err = s.service.DecideApprovalWithScope(in.ID, in.Allow, in.AlwaysAllow)
		}
	case "/api/permissions":
		var in wire.PermissionsInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
			err = s.service.SetPermissionMode(in.ID, in.Mode)
		}
	case "/api/pick-workspace":
		if s.picker == nil {
			s.fail(w, "Folder picker is available in the desktop app. Enter a path here instead.", 400)
			return
		}
		var path string
		path, err = s.picker()
		if err == nil {
			wire.WriteJSON(w, r.Method, r.URL.Path, wire.PathResponse{Path: path})
			return
		}
	default:
		if s.serveFeatureMutation(w, r, decode) {
			return
		}
		s.fail(w, "Not found", 404)
		return
	}
	if err != nil {
		s.fail(w, err.Error(), 400)
		return
	}
	wire.WriteJSON(w, r.Method, r.URL.Path, wire.OKResponse{OK: true})
}

func requestBodyLimit(path string) int64 {
	if path == "/api/send" || path == "/api/queue" || path == "/api/draft" {
		return 128 << 20
	}
	return 2 << 20
}

func (s *Server) socket(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"pith-desk"}})
	if err != nil {
		return
	}
	defer conn.CloseNow()
	ctx, cancel := context.WithCancel(r.Context())
	stop := context.AfterFunc(s.ctx, cancel)
	defer stop()
	defer cancel()
	ctx = conn.CloseRead(ctx)
	// Canceling a lease must close an idle socket as well as a busy writer.
	closeSocket := context.AfterFunc(ctx, func() { _ = conn.CloseNow() })
	defer closeSocket()
	ch := make(chan []byte, 1)
	s.mu.Lock()
	s.clients[ch] = struct{}{}
	initial := s.snapshot()
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.clients, ch); s.mu.Unlock() }()
	if err = conn.Write(ctx, websocket.MessageText, initial); err != nil {
		return
	}
	for {
		select {
		case <-ctx.Done():
			return
		case data := <-ch:
			if err = conn.Write(ctx, websocket.MessageText, data); err != nil {
				return
			}
		}
	}
}

func (s *Server) fail(w http.ResponseWriter, message string, status int) {
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(wire.ErrorResponse{Error: message})
}

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		s.fail(w, "Streaming unavailable", 500)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("X-Accel-Buffering", "no")
	ch := make(chan []byte, 1)
	s.mu.Lock()
	s.clients[ch] = struct{}{}
	initial := s.snapshot()
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.clients, ch); s.mu.Unlock() }()
	if _, err := fmt.Fprintf(w, "event: state\ndata: %s\n\n", initial); err != nil {
		return
	}
	flusher.Flush()
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-s.ctx.Done():
			return
		case data := <-ch:
			if _, err := fmt.Fprintf(w, "event: state\ndata: %s\n\n", data); err != nil {
				return
			}
			flusher.Flush()
		case <-ticker.C:
			if _, err := fmt.Fprint(w, ": keepalive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
