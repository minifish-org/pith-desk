// Package host serves the trusted desktop UI on an authenticated loopback port.
package host

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	assets "github.com/minifish-org/pith-desk"
	"github.com/minifish-org/pith-desk/internal/desk"
)

type Server struct {
	URL      string
	server   *http.Server
	listener net.Listener
	token    string
	service  *desk.Service
	picker   func() (string, error)
	files    http.Handler
	index    []byte
	ctx      context.Context
	cancel   context.CancelFunc
	mu       sync.Mutex
	clients  map[chan []byte]struct{}

	appearanceMu      sync.Mutex
	appearanceChanged func(desk.AppearanceMode)
	openFile          func(string) error
	revealFile        func(string) error
	exportMarkdown    func(string) error
}

func Start(service *desk.Service, picker func() (string, error), appearanceChanged ...func(desk.AppearanceMode)) (*Server, error) {
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	var key [32]byte
	if _, err = rand.Read(key[:]); err != nil {
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
	s := &Server{URL: "http://" + ln.Addr().String(), listener: ln, token: hex.EncodeToString(key[:]), service: service, picker: picker, files: http.FileServer(http.FS(web)), index: index, ctx: ctx, cancel: cancel, clients: make(map[chan []byte]struct{})}
	if len(appearanceChanged) > 0 {
		s.appearanceChanged = appearanceChanged[0]
	}
	s.server = &http.Server{Handler: http.HandlerFunc(s.serve), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
	go func() { _ = s.server.Serve(ln) }()
	go s.broadcast()
	return s, nil
}

func (s *Server) Close() error {
	s.cancel()
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
			data := s.snapshot()
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
		}
	}
}

func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' "+strings.Replace(s.URL, "http://", "ws://", 1)+"; img-src 'self' data:; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
	if r.Host != s.listener.Addr().String() {
		http.Error(w, "Invalid host", http.StatusForbidden)
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" && origin != s.URL {
		http.Error(w, "Invalid origin", http.StatusForbidden)
		return
	}
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		http.Error(w, "Cross-site access denied", http.StatusForbidden)
		return
	}
	if !strings.HasPrefix(r.URL.Path, "/api/") {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "Method not allowed", 405)
			return
		}
		if r.URL.Path == "/" {
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			index := strings.ReplaceAll(string(s.index), "__DESK_TOKEN__", s.token)
			index = strings.ReplaceAll(index, "__DESK_APPEARANCE__", string(s.service.Snapshot().Settings.Appearance))
			_, _ = w.Write([]byte(index))
			return
		}
		// Only the trusted built assets are served. Workspace files are never web roots.
		if strings.HasPrefix(r.URL.Path, "/assets/") || r.URL.Path == "/favicon.svg" {
			s.files.ServeHTTP(w, r)
			return
		}
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if r.URL.Path == "/api/socket" && r.Method == http.MethodGet {
		// Browsers cannot set Authorization on a WebSocket handshake. Carry
		// the process-local token in a request subprotocol, never in a URL.
		valid := false
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
		s.socket(w, r)
		return
	}
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+s.token)) != 1 {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	if r.URL.Path == "/api/events" && r.Method == http.MethodGet {
		s.events(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json")
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
	r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
	decode := func(dst any) error {
		d := json.NewDecoder(r.Body)
		d.DisallowUnknownFields()
		return d.Decode(dst)
	}
	var err error
	switch r.URL.Path {
	case "/api/config":
		var in desk.ConfigInput
		if err = decode(&in); err == nil {
			err = s.service.Configure(in)
		}
	case "/api/appearance":
		var in struct {
			Mode desk.AppearanceMode `json:"mode"`
		}
		if err = decode(&in); err == nil {
			// Serialize persisted changes and the native theme update so two
			// concurrent requests cannot leave the window on an older mode.
			s.appearanceMu.Lock()
			err = s.service.SetAppearance(in.Mode)
			if err == nil && s.appearanceChanged != nil {
				s.appearanceChanged(in.Mode)
			}
			s.appearanceMu.Unlock()
		}
	case "/api/workspaces":
		var in struct {
			Path string `json:"path"`
		}
		if err = decode(&in); err == nil {
			var workspace desk.Workspace
			workspace, err = s.service.AddWorkspace(in.Path)
			if err == nil {
				_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "workspace": workspace})
				return
			}
		}
	case "/api/conversations":
		var in struct {
			WorkspaceID string `json:"workspaceId"`
		}
		if err = decode(&in); err == nil {
			_, err = s.service.CreateConversation(in.WorkspaceID)
		}
	case "/api/open":
		var in struct {
			ID string `json:"id"`
		}
		if err = decode(&in); err == nil {
			err = s.service.OpenConversation(in.ID)
		}
	case "/api/send":
		var in struct {
			Text string `json:"text"`
		}
		if err = decode(&in); err == nil {
			err = s.service.Send(in.Text)
		}
	case "/api/abort":
		s.service.Abort()
	case "/api/approval":
		var in struct {
			ID          string `json:"id"`
			Allow       bool   `json:"allow"`
			AlwaysAllow bool   `json:"alwaysAllow,omitempty"`
		}
		if err = decode(&in); err == nil {
			err = s.service.DecideApprovalWithScope(in.ID, in.Allow, in.AlwaysAllow)
		}
	case "/api/permissions":
		var in struct {
			ID   string              `json:"id"`
			Mode desk.PermissionMode `json:"mode"`
		}
		if err = decode(&in); err == nil {
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
			_ = json.NewEncoder(w).Encode(map[string]string{"path": path})
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
	_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

func (s *Server) socket(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"pith-desk"}})
	if err != nil {
		return
	}
	defer conn.CloseNow()
	ctx := conn.CloseRead(s.ctx)
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
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
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
