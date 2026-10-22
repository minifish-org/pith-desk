package host

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/minifish-org/pith-desk/internal/wire"
)

const previewCookie = "pith_preview"
const previewControl = "/_pith_preview"

// A separate origin preserves root-relative assets and ordinary dev-server HMR
// without giving project scripts Desk's origin, storage or credentials.
type webPreview struct {
	mu         sync.Mutex
	origin     string
	baseOrigin string
	local      bool
	usedPorts  map[string]bool
	server     *http.Server
	listener   net.Listener
	grant      *previewGrant
	transport  *http.Transport
}
type previewGrant struct {
	key       string
	id        string
	target    *url.URL
	workspace string
	ctx       context.Context
	cancel    context.CancelFunc
	origin    string
}

func (s *Server) startWebPreview(listen, origin string) error {
	local := origin == ""
	deskURL, _ := url.Parse(s.URL)
	// An HTTPS deployment must explicitly route a second HTTPS origin. Never
	// silently expose an unauthenticated port or downgrade to mixed content.
	if origin == "" && (!loopbackHost(deskURL.Hostname()) || deskURL.Scheme == "https") {
		return nil
	}
	if listen == "" {
		listen = "127.0.0.1:0"
	}
	ln, err := net.Listen("tcp", listen)
	if err != nil {
		return err
	}
	if origin == "" {
		origin = "http://" + ln.Addr().String()
	}
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" ||
		(u.Scheme != "https" && (u.Scheme != "http" || !loopbackHost(u.Hostname()))) ||
		origin == s.URL || (deskURL.Scheme == "https" && u.Scheme != "https") ||
		(!loopbackHost(deskURL.Hostname()) && u.Hostname() == deskURL.Hostname()) {
		ln.Close()
		return errors.New("preview origin must be a separate HTTPS hostname (or a separate loopback HTTP origin)")
	}
	local = u.Scheme == "http"
	p := &webPreview{origin: origin, baseOrigin: origin, local: local, usedPorts: map[string]bool{ln.Addr().String(): true}, listener: ln, transport: &http.Transport{Proxy: nil, DialContext: dialPreviewLoopback, ResponseHeaderTimeout: 15 * time.Second, IdleConnTimeout: 30 * time.Second}}
	p.server = &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { s.serveWebPreview(p, w, r) }), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
	s.preview = p
	server := p.server
	go func() { _ = server.Serve(ln) }()
	return nil
}

func (p *webPreview) close() {
	p.mu.Lock()
	if p.grant != nil {
		p.grant.cancel()
	}
	server := p.server
	p.mu.Unlock()
	p.transport.CloseIdleConnections()
	_ = server.Close()
}

// Try both literal loopback families for localhost without consulting DNS.
// Fallback happens while connecting, before an HTTP request or write is sent.
func dialPreviewLoopback(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	if host == "localhost" {
		conn, err := dialer.DialContext(ctx, network, net.JoinHostPort("::1", port))
		if err == nil {
			return conn, nil
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return dialer.DialContext(ctx, network, net.JoinHostPort("127.0.0.1", port))
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		return nil, errors.New("preview connections require a literal loopback address")
	}
	return dialer.DialContext(ctx, network, address)
}

func previewAddress(address string) (*url.URL, bool, error) {
	if len(address) > 8192 || strings.TrimSpace(address) != address {
		return nil, false, errors.New("Enter an HTTP or HTTPS address")
	}
	u, err := url.Parse(address)
	if err != nil || u.Host == "" || u.User != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, false, errors.New("Enter an HTTP or HTTPS address without embedded credentials")
	}
	local := loopbackHost(u.Hostname())
	if local {
		port, err := strconv.Atoi(u.Port())
		if u.Scheme != "http" || err != nil || port < 1024 || port > 65535 {
			return nil, false, errors.New("Local previews require http://localhost:PORT with a port from 1024 to 65535")
		}
		u.Host = net.JoinHostPort(u.Hostname(), strconv.Itoa(port))
		if strings.HasPrefix(u.Path, "//") || u.Path == previewControl {
			return nil, false, errors.New("This local preview path is reserved or unsupported")
		}
	}
	return u, local, nil
}

func (s *Server) openWebPreview(w http.ResponseWriter, r *http.Request) {
	var in wire.WebPreviewInput
	decode := func(value any) error {
		d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10))
		d.DisallowUnknownFields()
		return d.Decode(value)
	}
	if err := wire.Decode(r.URL.Path, decode, &in); err != nil {
		s.fail(w, "Invalid preview request", 400)
		return
	}
	if _, err := s.service.WorkspaceDirectory(in.WorkspaceID); err != nil {
		s.fail(w, err.Error(), 400)
		return
	}
	u, local, err := previewAddress(in.Address)
	if err != nil {
		s.fail(w, err.Error(), 400)
		return
	}
	deskURL, _ := url.Parse(s.URL)
	if u.Host == deskURL.Host || u.Hostname() == deskURL.Hostname() && u.Port() == deskURL.Port() {
		s.fail(w, "Pith Desk cannot preview itself", 400)
		return
	}
	if !local {
		// No server-side request is made to an external website.
		if s.preview != nil {
			s.preview.mu.Lock()
			if s.preview.grant != nil {
				s.preview.grant.cancel()
				s.preview.grant = nil
			}
			s.preview.mu.Unlock()
		}
		wire.WriteJSON(w, r.Method, r.URL.Path, wire.WebPreviewResponse{URL: u.String(), ExternalURL: u.String()})
		return
	}
	p := s.preview
	if p == nil {
		s.fail(w, "Server local previews need --preview-listen and a separate HTTPS --preview-origin. See README.", 400)
		return
	}
	_, deskPort, _ := net.SplitHostPort(s.listener.Addr().String())
	p.mu.Lock()
	_, previewPort, _ := net.SplitHostPort(p.listener.Addr().String())
	p.mu.Unlock()
	if u.Port() == deskPort || u.Port() == previewPort {
		s.fail(w, "Pith Desk ports cannot be previewed", 400)
		return
	}
	if s.development != nil && u.Port() == s.development.url.Port() {
		s.fail(w, "Desk frontend ports cannot be previewed", 400)
		return
	}
	// The transport connects localhost only to literal ::1 / 127.0.0.1. No DNS
	// resolution, redirects or request parameters can select another address.
	target := *u
	target.Path = ""
	target.RawPath = ""
	target.RawQuery = ""
	target.Fragment = ""
	ctx := s.ctx
	if s.access != nil {
		ctx = r.Context().Value(leaseContextKey{}).(*browserLease).ctx
	}
	ctx, cancel := context.WithCancel(ctx)
	g := &previewGrant{key: randomCredential(), id: randomCredential(), target: &target, workspace: in.WorkspaceID, ctx: ctx, cancel: cancel}
	p.mu.Lock()
	// Never reuse an origin: an old document must not inherit a new grant's
	// browser cookies after takeover. Local use rotates the loopback port;
	// HTTPS deployments route random subdomains through one existing listener.
	if p.local {
		var ln net.Listener
		var err error
		for attempt := 0; attempt < 32; attempt++ {
			ln, err = net.Listen("tcp4", "127.0.0.1:0")
			if err != nil {
				break
			}
			if !p.usedPorts[ln.Addr().String()] {
				p.usedPorts[ln.Addr().String()] = true
				break
			}
			ln.Close()
			ln = nil
		}
		if ln == nil && err == nil {
			err = errors.New("no unused preview port")
		}
		if err != nil {
			p.mu.Unlock()
			cancel()
			s.fail(w, "Preview listener unavailable", 500)
			return
		}
		server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { s.serveWebPreview(p, w, r) }), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
		oldServer := p.server
		p.server = server
		p.listener = ln
		g.origin = "http://" + ln.Addr().String()
		go func() { _ = oldServer.Close(); _ = server.Serve(ln) }()
	} else {
		base, _ := url.Parse(p.baseOrigin)
		base.Host = g.id[:32] + "." + base.Host
		g.origin = base.String()
	}
	if p.grant != nil {
		p.grant.cancel()
	}
	p.grant = g
	p.origin = g.origin
	p.mu.Unlock()
	// Only a scoped preview grant goes in the fragment. It is consumed by the
	// trusted bootstrap, never sent in URLs, referrers or upstream requests.
	path := u.RequestURI()
	if u.Fragment != "" {
		path += "#" + u.EscapedFragment()
	}
	fragment := url.Values{"grant": {g.key}, "path": {path}}.Encode()
	entry := g.origin + previewControl + "#" + fragment
	external := g.origin + path
	if s.access == nil {
		external = u.String()
	}
	wire.WriteJSON(w, r.Method, r.URL.Path, wire.WebPreviewResponse{ID: g.id, URL: entry, ExternalURL: external})
}

func (s *Server) closeWebPreview(w http.ResponseWriter, r *http.Request) {
	var in wire.IDInput
	decode := func(value any) error { return json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(value) }
	if wire.Decode(r.URL.Path, decode, &in) != nil {
		s.fail(w, "Invalid preview close request", 400)
		return
	}
	if p := s.preview; p != nil {
		p.mu.Lock()
		if p.grant != nil && p.grant.id == in.ID {
			p.grant.cancel()
			p.grant = nil
		}
		p.mu.Unlock()
	}
	wire.WriteJSON(w, r.Method, r.URL.Path, wire.OKResponse{OK: true})
}

func (s *Server) serveWebPreview(p *webPreview, w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	p.mu.Lock()
	g := p.grant
	p.mu.Unlock()
	if g == nil || g.ctx.Err() != nil {
		http.Error(w, "Preview expired. Refresh it in Pith Desk.", 410)
		return
	}
	u, _ := url.Parse(g.origin)
	if r.Host != u.Host || r.Header.Get("Origin") != "" && r.Header.Get("Origin") != g.origin {
		http.Error(w, "Invalid preview origin", 403)
		return
	}
	if r.URL.Path == previewControl && r.Method == http.MethodGet {
		// No application state or credential is present in this public shell.
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'nonce-pith-preview'; connect-src 'self'; base-uri 'none'; frame-ancestors "+s.URL)
		fmt.Fprint(w, `<!doctype html><meta charset="utf-8"><title>Web preview</title><p id="status">Opening preview…</p><script nonce="pith-preview">const data=new URLSearchParams(location.hash.slice(1));history.replaceState(null,'',location.pathname);const path=data.get('path')||'/';if(!path.startsWith('/')||path.startsWith('//'))throw Error('Invalid preview path');fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grant:data.get('grant')})}).then(r=>{if(!r.ok)throw Error('Preview expired. Refresh it in Pith Desk.');location.replace(path)}).catch(e=>document.getElementById('status').textContent=e.message)</script>`)
		return
	}
	if _, err := s.service.WorkspaceDirectory(g.workspace); err != nil {
		g.cancel()
		http.Error(w, "Workspace was removed", 410)
		return
	}
	if r.URL.Path == previewControl && r.Method == http.MethodPost {
		if r.Header.Get("Origin") != g.origin || r.Header.Get("Content-Type") != "application/json" {
			http.Error(w, "Invalid bootstrap", 403)
			return
		}
		var input struct {
			Grant string `json:"grant"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&input) != nil || subtle.ConstantTimeCompare([]byte(input.Grant), []byte(g.key)) != 1 {
			http.Error(w, "Invalid preview grant", 403)
			return
		}
		http.SetCookie(w, &http.Cookie{Name: previewCookie, Value: g.key, Path: "/", HttpOnly: true, Secure: u.Scheme == "https", SameSite: http.SameSiteStrictMode})
		w.WriteHeader(http.StatusNoContent)
		return
	}
	cookie, err := r.Cookie(previewCookie)
	if err != nil || subtle.ConstantTimeCompare([]byte(cookie.Value), []byte(g.key)) != 1 {
		http.Error(w, "Open this preview from Pith Desk first", 401)
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	stop := context.AfterFunc(g.ctx, cancel)
	defer stop()
	defer cancel()
	proxy := &httputil.ReverseProxy{Transport: p.transport, FlushInterval: -1, Rewrite: func(pr *httputil.ProxyRequest) {
		pr.SetURL(g.target)
		pr.Out.Host = g.target.Host
		for key := range pr.Out.Header {
			lower := strings.ToLower(key)
			if lower == "cookie" || lower == "authorization" || lower == "proxy-authorization" || lower == "referer" || lower == "forwarded" || strings.HasPrefix(lower, "x-forwarded-") || strings.HasPrefix(lower, "x-desk-") {
				pr.Out.Header.Del(key)
			}
		}
		if pr.Out.Header.Get("Origin") != "" {
			pr.Out.Header.Set("Origin", g.target.String())
		}
	}, ModifyResponse: func(response *http.Response) error {
		response.Header.Del("Set-Cookie")
		response.Header.Del("Clear-Site-Data")
		response.Header.Set("Cache-Control", "no-store")
		response.Header.Set("Referrer-Policy", "no-referrer")
		response.Header.Add("Content-Security-Policy", "worker-src 'none'")
		// Workers could survive the lease and intercept a later preview target.
		if r.Header.Get("Service-Worker") != "" || r.Header.Get("Sec-Fetch-Dest") == "serviceworker" {
			return errors.New("service workers are disabled in previews")
		}
		if location := response.Header.Get("Location"); location != "" {
			next, err := response.Request.URL.Parse(location)
			if err != nil || next.Scheme != g.target.Scheme || next.Host != g.target.Host {
				return errors.New("preview redirect left the selected local port; open it externally")
			}
			next.Scheme = u.Scheme
			next.Host = u.Host
			response.Header.Set("Location", next.String())
		}
		// Preserve upstream X-Frame-Options and CSP, including frame-ancestors.
		return nil
	}, ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
		var networkError net.Error
		if errors.As(err, &networkError) {
			http.Error(w, "Cannot connect to the local project at "+g.target.Host+". Check that its development server is running, then refresh the preview.", http.StatusBadGateway)
			return
		}
		http.Error(w, "Preview unavailable or redirect blocked. Check the project, then refresh or open externally.", 502)
	}}
	proxy.ServeHTTP(w, r.WithContext(ctx))
}
