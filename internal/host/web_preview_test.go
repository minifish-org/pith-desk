package host

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/minifish-org/pith-desk/internal/wire"
)

func admitPreview(t *testing.T, b *serverBrowser, address string) wire.WebPreviewResponse {
	t.Helper()
	workspace, err := b.s.service.AddWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	response, data := b.request(t, "POST", "/api/web-preview", wire.WebPreviewInput{WorkspaceID: workspace.ID, Address: address}, "")
	var result wire.WebPreviewResponse
	if response.StatusCode != 200 || json.Unmarshal(data, &result) != nil {
		t.Fatalf("preview admission: %d %s", response.StatusCode, data)
	}
	return result
}
func mustPreviewHost(entry string) string { u, _ := url.Parse(entry); return u.Host }
func previewOrigin(entry string) string   { u, _ := url.Parse(entry); return u.Scheme + "://" + u.Host }
func previewGrantFor(p *webPreview, entry string) *previewGrant {
	u, _ := url.Parse(entry)
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.grants[u.Host]
}
func bootstrapPreview(t *testing.T, entry string) *http.Cookie {
	t.Helper()
	u, _ := url.Parse(entry)
	values, _ := url.ParseQuery(u.Fragment)
	u.Fragment = ""
	body, _ := json.Marshal(map[string]string{"grant": values.Get("grant")})
	req, _ := http.NewRequest("POST", u.String(), bytes.NewReader(body))
	req.Header.Set("Origin", u.Scheme+"://"+u.Host)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 204 {
		data, _ := io.ReadAll(resp.Body)
		t.Fatalf("bootstrap: %d %s", resp.StatusCode, data)
	}
	for _, cookie := range resp.Cookies() {
		if strings.HasPrefix(cookie.Name, previewCookie+"_") {
			if !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode {
				t.Fatal("unsafe preview cookie")
			}
			return cookie
		}
	}
	t.Fatal("no preview cookie")
	return nil
}

func TestWebPreviewAdmissionAndAddressBoundaries(t *testing.T) {
	s := testServerMode(t, "")
	b := &serverBrowser{s: s}
	b.login(t)
	b.acquire(t, "", false)
	workspace, err := s.service.AddWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, address := range []string{"file:///etc/passwd", "javascript:alert(1)", "http://:80/", "http://localhost:65536/", "https://user:password@example.com/", "http://localhost:0/", "http://127.1/", "http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/", s.URL, "http://127.0.0.2:" + strings.Split(s.URL, ":")[2], s.preview.baseOrigin} {
		resp, data := b.request(t, "POST", "/api/web-preview", wire.WebPreviewInput{WorkspaceID: workspace.ID, Address: address}, "")
		if resp.StatusCode != 400 {
			t.Fatalf("admitted %s: %d %s", address, resp.StatusCode, data)
		}
	}
	self, _ := url.Parse(s.URL)
	self.Host = "localhost:0" + self.Port()
	resp, data := b.request(t, "POST", "/api/web-preview", wire.WebPreviewInput{WorkspaceID: workspace.ID, Address: self.String()}, "")
	if resp.StatusCode != 400 {
		t.Fatalf("zero-padded Desk port admitted: %d %s", resp.StatusCode, data)
	}
	// External sites are returned directly, including non-loopback LAN names;
	// they are never fetched by Go (this hostname deliberately cannot resolve).
	for _, address := range []string{"https://never-fetch.example.invalid/path", "http://8.8.8.8/", "http://192.168.1.20:3000/", "https://10.0.0.2/", "http://[fd00::1]:8080/"} {
		result := admitPreview(t, b, address)
		if result.URL != address || result.ExternalURL != address || result.ID != "" {
			t.Fatalf("external proxy for %s: %+v", address, result)
		}
	}
	for _, address := range []string{"http://localhost/", "http://localhost./", "http://project.localhost/", "http://localhost:80/", "https://localhost/", "https://LOCALHOST:5173/", "http://[::1]:443/", "http://localhost:5173//nested", "http://localhost:5173" + previewControl} {
		result := admitPreview(t, b, address)
		if result.ID == "" || result.URL == address {
			t.Fatalf("Server localhost not proxied: %s %+v", address, result)
		}
		u, _ := url.Parse(address)
		s.preview.mu.Lock()
		target := *s.preview.grants[mustPreviewHost(result.URL)].target
		s.preview.mu.Unlock()
		wantPort := u.Port()
		if wantPort == "" {
			wantPort = "80"
			if u.Scheme == "https" {
				wantPort = "443"
			}
		}
		if target.Scheme != u.Scheme || target.Port() != wantPort {
			t.Fatalf("Server localhost changed target: %s %s", address, target.String())
		}
	}
	remote := testServerMode(t, "https://desk.example.com")
	if remote.preview != nil {
		t.Fatal("remote preview exposed without a separate origin")
	}
	rb := &serverBrowser{s: remote}
	rb.login(t)
	rb.acquire(t, "", false)
	rw, _ := remote.service.AddWorkspace(t.TempDir())
	resp, data = rb.request(t, "POST", "/api/web-preview", wire.WebPreviewInput{WorkspaceID: rw.ID, Address: "http://localhost:5173"}, "")
	if resp.StatusCode != 400 || !bytes.Contains(data, []byte("preview-origin")) {
		t.Fatalf("missing remote configuration: %d %s", resp.StatusCode, data)
	}
}

func TestWebPreviewServerPathsAndHTTPSKeepNormalCertificateValidation(t *testing.T) {
	for _, test := range []struct {
		name          string
		secure, trust bool
	}{{"http", false, false}, {"https-untrusted", true, false}, {"https-trusted", true, true}} {
		t.Run(test.name, func(t *testing.T) {
			project := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				io.WriteString(w, r.Method+" "+r.URL.RequestURI())
			}))
			if test.secure {
				project.StartTLS()
			} else {
				project.Start()
			}
			defer project.Close()
			s := testServerMode(t, "")
			if test.trust {
				// Trust only this fixture's certificate; production retains Go's defaults.
				roots := x509.NewCertPool()
				roots.AddCert(project.Certificate())
				s.preview.transport.TLSClientConfig = &tls.Config{RootCAs: roots}
			}
			b := &serverBrowser{s: s}
			b.login(t)
			b.acquire(t, "", false)
			opened := admitPreview(t, b, project.URL+previewControl)
			cookie := bootstrapPreview(t, opened.URL)
			request := func(method, path string) (int, string) {
				t.Helper()
				req, _ := http.NewRequest(method, previewOrigin(opened.URL)+path, nil)
				req.AddCookie(cookie)
				resp, err := http.DefaultClient.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				defer resp.Body.Close()
				data, _ := io.ReadAll(resp.Body)
				return resp.StatusCode, string(data)
			}
			if test.secure && !test.trust {
				if status, _ := request("GET", "/"); status != 502 {
					t.Fatal("untrusted project certificate was accepted")
				}
				return
			}
			for _, test := range []struct{ method, path string }{{"GET", previewControl}, {"POST", previewControl}, {"GET", "//nested?q=1"}} {
				status, body := request(test.method, test.path)
				if status != 200 || body != test.method+" "+test.path {
					t.Fatalf("project path intercepted: %d %q", status, body)
				}
			}
		})
	}
}

func TestWebPreviewProxyStripsCredentialsPreservesPoliciesAndPinsTarget(t *testing.T) {
	seen := make(chan http.Header, 10)
	project := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- r.Header.Clone()
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, "http://169.254.169.254/latest", 302)
			return
		}
		if r.URL.Path == "/relative" {
			http.Redirect(w, r, "/assets/module.js", 302)
			return
		}
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy", "frame-ancestors 'none'")
		http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "evil"})
		io.WriteString(w, r.URL.RequestURI())
	}))
	defer project.Close()
	s := testServerMode(t, "")
	b := &serverBrowser{s: s}
	b.login(t)
	b.acquire(t, "", false)
	opened := admitPreview(t, b, strings.Replace(project.URL, "127.0.0.1", "localhost", 1)+"/nested?q=1#section")
	if strings.Contains(opened.URL, fixtureServerToken) || strings.Contains(opened.URL, b.lease) || strings.Contains(opened.URL, b.cookie.Value) {
		t.Fatal("Desk credential in preview URL")
	}
	cookie := bootstrapPreview(t, opened.URL)
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	get := func(path string, withCookie bool, origin string) *http.Response {
		t.Helper()
		req, _ := http.NewRequest("GET", previewOrigin(opened.URL)+path, nil)
		if withCookie {
			req.AddCookie(cookie)
			req.AddCookie(b.cookie)
		}
		req.Header.Set("Authorization", "Bearer DESK_SECRET")
		req.Header.Set("X-Desk-Lease", b.lease)
		req.Header.Set("X-Desk-Request", "99")
		req.Header.Set("Referer", s.URL)
		req.Header.Set("X-Forwarded-Host", "attacker")
		req.Header.Set("Origin", origin)
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}
	resp := get("/nested?q=1", false, "")
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatal("unauthenticated proxy")
	}
	resp = get("/nested?q=1", true, "https://evil.example")
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatal("foreign origin")
	}
	resp = get("/nested?q=1", true, previewOrigin(opened.URL))
	data, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || string(data) != "/nested?q=1" || resp.Header.Get("X-Frame-Options") != "DENY" || !strings.Contains(strings.Join(resp.Header.Values("Content-Security-Policy"), ";"), "frame-ancestors 'none'") || len(resp.Cookies()) != 0 {
		t.Fatalf("proxy/policy: %d %s %v", resp.StatusCode, data, resp.Header)
	}
	h := <-seen
	for _, key := range []string{"Cookie", "Authorization", "X-Desk-Lease", "X-Desk-Request", "Referer", "X-Forwarded-Host"} {
		if h.Get(key) != "" {
			t.Errorf("leaked %s", key)
		}
	}
	resp = get("/redirect", true, "")
	resp.Body.Close()
	if resp.StatusCode != 502 {
		t.Fatal("external redirect followed")
	}
	resp = get("/relative", true, "")
	resp.Body.Close()
	if resp.StatusCode != 302 || resp.Header.Get("Location") != previewOrigin(opened.URL)+"/assets/module.js" {
		t.Fatal("local redirect not rewritten")
	}
	current := &serverBrowser{s: s, cookie: b.cookie}
	current.acquire(t, "", true)
	revoked := httptest.NewRecorder()
	request := httptest.NewRequest("GET", previewOrigin(opened.URL)+"/nested", nil)
	request.AddCookie(cookie)
	s.serveWebPreview(s.preview, revoked, request)
	if revoked.Code != 410 {
		t.Fatal("revoked preview still available")
	}
}

func TestWebPreviewWebSocketAndStreamingRevocation(t *testing.T) {
	for _, revoke := range []string{"takeover", "workspace", "close", "logout", "expiry"} {
		t.Run(revoke, func(t *testing.T) {
			streamCanceled := make(chan struct{}, 1)
			project := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/stream" {
					w.Header().Set("Content-Type", "text/event-stream")
					io.WriteString(w, "data: ready\n\n")
					w.(http.Flusher).Flush()
					<-r.Context().Done()
					streamCanceled <- struct{}{}
					return
				}
				conn, err := websocket.Accept(w, r, nil)
				if err != nil {
					return
				}
				defer conn.CloseNow()
				ctx := r.Context()
				for {
					kind, data, err := conn.Read(ctx)
					if err != nil {
						return
					}
					if conn.Write(ctx, kind, data) != nil {
						return
					}
				}
			}))
			defer project.Close()
			s := testServerMode(t, "")
			b := &serverBrowser{s: s}
			b.login(t)
			b.acquire(t, "", false)
			opened := admitPreview(t, b, project.URL)
			cookie := bootstrapPreview(t, opened.URL)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			conn, _, err := websocket.Dial(ctx, strings.Replace(previewOrigin(opened.URL), "http:", "ws:", 1)+"/hmr", &websocket.DialOptions{HTTPHeader: http.Header{"Cookie": {cookie.String()}, "Origin": {previewOrigin(opened.URL)}}})
			if err != nil {
				t.Fatal(err)
			}
			defer conn.CloseNow()
			if err = conn.Write(ctx, websocket.MessageText, []byte("hot-update")); err != nil {
				t.Fatal(err)
			}
			_, data, err := conn.Read(ctx)
			if err != nil || string(data) != "hot-update" {
				t.Fatalf("HMR echo: %s %v", data, err)
			}
			req, _ := http.NewRequest("GET", previewOrigin(opened.URL)+"/stream", nil)
			req.AddCookie(cookie)
			stream, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer stream.Body.Close()
			switch revoke {
			case "takeover":
				current := &serverBrowser{s: s, cookie: b.cookie}
				current.acquire(t, "", true)
			case "workspace":
				if err := s.service.RemoveWorkspace(previewGrantFor(s.preview, opened.URL).workspace, 0); err != nil {
					t.Fatal(err)
				}
			case "close":
				b.request(t, "POST", "/api/web-preview/close", wire.IDInput{ID: opened.ID}, "")
			case "logout":
				b.request(t, "POST", "/api/server/logout", wire.EmptyInput{}, "")
			case "expiry":
				s.access.mu.Lock()
				s.access.lease.expires = time.Time{}
				s.access.expireLocked()
				s.access.mu.Unlock()
			}
			if _, _, err = conn.Read(ctx); err == nil {
				t.Fatal("revoked socket remained open")
			}
			select {
			case <-streamCanceled:
			case <-ctx.Done():
				t.Fatal("revoked stream remained open")
			}

		})
	}
}

func TestWebPreviewDesktopBearerAndDirectAddresses(t *testing.T) {
	s := testServer(t)
	workspace, _ := s.service.AddWorkspace(t.TempDir())
	open := func(token, address string) (*http.Response, wire.WebPreviewResponse) {
		body, _ := json.Marshal(wire.WebPreviewInput{WorkspaceID: workspace.ID, Address: address})
		req, _ := http.NewRequest("POST", s.URL+"/api/web-preview", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var value wire.WebPreviewResponse
		_ = json.NewDecoder(resp.Body).Decode(&value)
		return resp, value
	}
	resp, _ := open("", "http://localhost:5173")
	if resp.StatusCode != 401 {
		t.Fatal("missing Desktop bearer admitted")
	}
	for _, address := range []string{"http://localhost:5173", "http://localhost/", "https://localhost:443/", "http://127.0.0.1:80/", "http://[::1]:3000/", "http://localhost:5173//nested", "http://localhost:5173" + previewControl, "https://192.168.1.20/"} {
		resp, result := open(s.token, address)
		if resp.StatusCode != 200 || result.ID != "" || result.URL != address || result.ExternalURL != address {
			t.Fatalf("Desktop address not direct: %s %d %+v", address, resp.StatusCode, result)
		}
	}
	if s.preview != nil {
		t.Fatal("Desktop started an unused preview proxy")
	}
}

func TestWebPreviewServerScopedClose(t *testing.T) {
	s := testServerMode(t, "")
	b := &serverBrowser{s: s}
	b.login(t)
	b.acquire(t, "", false)
	first := admitPreview(t, b, "http://localhost:5173")
	second := admitPreview(t, b, "http://localhost:5173")
	resp, data := b.request(t, "POST", "/api/web-preview/close", wire.IDInput{ID: first.ID}, "")
	if resp.StatusCode != 200 {
		t.Fatalf("close: %d %s", resp.StatusCode, data)
	}
	s.preview.mu.Lock()
	current := s.preview.grants[mustPreviewHost(second.URL)].id
	s.preview.mu.Unlock()
	if current != second.ID {
		t.Fatal("late close revoked replacement")
	}
}

func TestWebPreviewRemoteOriginsRotateWithoutSharingLeaseCookies(t *testing.T) {
	s := testServerMode(t, "https://desk.example.com")
	if err := s.startWebPreview("127.0.0.1:0", "https://preview.example.com"); err != nil {
		t.Fatal(err)
	}
	b := &serverBrowser{s: s}
	b.login(t)
	b.acquire(t, "", false)
	first := admitPreview(t, b, "http://localhost:5173/path")
	u, _ := url.Parse(first.URL)
	if !strings.HasSuffix(u.Host, ".preview.example.com") || u.Host == "preview.example.com" {
		t.Fatal("preview did not get a fresh subdomain")
	}
	values, _ := url.ParseQuery(u.Fragment)
	body, _ := json.Marshal(map[string]string{"grant": values.Get("grant")})
	req, _ := http.NewRequest("POST", "http://"+s.preview.listener.Addr().String()+previewControl, bytes.NewReader(body))
	req.Host = u.Host
	req.Header.Set("Origin", "https://"+u.Host)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 204 || len(resp.Cookies()) != 1 || !resp.Cookies()[0].Secure || resp.Cookies()[0].Domain != "" {
		t.Fatalf("unsafe remote bootstrap: %d %v", resp.StatusCode, resp.Cookies())
	}
	second := admitPreview(t, b, "http://localhost:5173/path")
	next, _ := url.Parse(second.URL)
	if next.Host == u.Host {
		t.Fatal("new preview reused an old document's origin")
	}
	// Even with the latest cookie, another origin must never control a
	// different project. Both Host and cross-origin fetches are rejected.
	for _, test := range []struct{ host, origin string }{{u.Host, "https://" + u.Host}, {next.Host, "https://" + u.Host}} {
		req, _ := http.NewRequest("GET", "http://"+s.preview.listener.Addr().String()+"/", nil)
		req.Host = test.host
		req.Header.Set("Origin", test.origin)
		s.preview.mu.Lock()
		key := s.preview.grants[next.Host].key
		s.preview.mu.Unlock()
		req.AddCookie(&http.Cookie{Name: previewCookie + "_" + second.ID, Value: key})
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 401 && resp.StatusCode != 403 {
			t.Fatalf("retired origin admitted: %d", resp.StatusCode)
		}
	}
}

func TestWebPreviewLocalhostReachesBothLoopbackFamilies(t *testing.T) {
	for _, family := range []struct{ network, address string }{{"tcp4", "127.0.0.1:0"}, {"tcp6", "[::1]:0"}} {
		t.Run(family.network, func(t *testing.T) {
			listener, err := net.Listen(family.network, family.address)
			if err != nil {
				t.Skipf("loopback family unavailable: %v", err)
			}
			project := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/hmr" {
					conn, err := websocket.Accept(w, r, nil)
					if err != nil {
						return
					}
					defer conn.CloseNow()
					kind, data, err := conn.Read(r.Context())
					if err == nil {
						_ = conn.Write(r.Context(), kind, data)
					}
					return
				}
				io.WriteString(w, "loopback project ready")
			}))
			project.Listener.Close()
			project.Listener = listener
			project.Start()
			defer project.Close()
			_, port, _ := net.SplitHostPort(listener.Addr().String())
			s := testServerMode(t, "")
			b := &serverBrowser{s: s}
			b.login(t)
			b.acquire(t, "", false)
			opened := admitPreview(t, b, "http://localhost:"+port+"/nested")
			cookie := bootstrapPreview(t, opened.URL)
			req, _ := http.NewRequest("GET", previewOrigin(opened.URL)+"/nested", nil)
			req.AddCookie(cookie)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			data, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode != 200 || string(data) != "loopback project ready" {
				t.Fatalf("localhost preview failed for %s: %d %s", family.network, resp.StatusCode, data)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			conn, _, err := websocket.Dial(ctx, strings.Replace(previewOrigin(opened.URL), "http:", "ws:", 1)+"/hmr", &websocket.DialOptions{HTTPHeader: http.Header{"Cookie": {cookie.String()}, "Origin": {previewOrigin(opened.URL)}}})
			if err != nil {
				t.Fatal(err)
			}
			defer conn.CloseNow()
			if err := conn.Write(ctx, websocket.MessageText, []byte("hot update")); err != nil {
				t.Fatal(err)
			}
			_, data, err = conn.Read(ctx)
			if err != nil || string(data) != "hot update" {
				t.Fatalf("localhost HMR failed: %s %v", data, err)
			}
		})
	}
}

func TestWebPreviewIndependentGrantsAndRevocation(t *testing.T) {
	for _, revoke := range []string{"close", "logout", "expire", "workspace"} {
		t.Run(revoke, func(t *testing.T) {
			project := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, r.URL.RequestURI()) }))
			defer project.Close()
			s := testServerMode(t, "")
			b := &serverBrowser{s: s}
			b.login(t)
			b.acquire(t, "", false)
			first := admitPreview(t, b, project.URL+"/first")
			second := admitPreview(t, b, project.URL+"/second")
			cookies := []*http.Cookie{bootstrapPreview(t, first.URL), bootstrapPreview(t, second.URL)}
			if cookies[0].Name == cookies[1].Name {
				t.Fatal("loopback previews share a cookie name across ports")
			}
			// Browser cookies are host-scoped, not port-scoped. Send both, as a
			// real browser does, and prove each origin selects only its own grant.
			check := func(opened wire.WebPreviewResponse, want int) {
				t.Helper()
				r := httptest.NewRequest("GET", previewOrigin(opened.URL)+"/asset.js", nil)
				for _, cookie := range cookies {
					r.AddCookie(cookie)
				}
				w := httptest.NewRecorder()
				s.serveWebPreview(s.preview, w, r)
				if w.Code != want {
					t.Fatalf("preview status %d want %d: %s", w.Code, want, w.Body.String())
				}
			}
			check(first, 200)
			check(second, 200)
			admitPreview(t, b, "https://example.invalid/") // external intent cannot revoke either
			check(first, 200)
			check(second, 200)
			g := previewGrantFor(s.preview, first.URL)
			switch revoke {
			case "close":
				b.request(t, "POST", "/api/web-preview/close", wire.IDInput{ID: first.ID}, "")
			case "logout":
				b.request(t, "POST", "/api/server/logout", wire.EmptyInput{}, "")
			case "expire":
				s.access.mu.Lock()
				s.access.lease.expires = time.Time{}
				s.access.expireLocked()
				s.access.mu.Unlock()
			case "workspace":
				if err := s.service.RemoveWorkspace(g.workspace, 0); err != nil {
					t.Fatal(err)
				}
			}
			check(first, 410)
			if revoke == "close" || revoke == "workspace" {
				check(second, 200)
			} else {
				check(second, 410)
			}
		})
	}
}
