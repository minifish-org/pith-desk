package host

import (
	"bytes"
	"context"
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
		if cookie.Name == previewCookie {
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
	for _, address := range []string{"file:///etc/passwd", "javascript:alert(1)", "http://user:password@example.com/", "http://localhost/", "http://localhost:80/", "https://localhost:5173/", s.URL, "http://127.0.0.2:" + strings.Split(s.URL, ":")[2], s.preview.origin} {
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
	result := admitPreview(t, b, "https://never-fetch.example.invalid/path")
	if result.URL != "https://never-fetch.example.invalid/path" || result.ID != "" {
		t.Fatalf("external proxy: %+v", result)
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
		req, _ := http.NewRequest("GET", s.preview.origin+path, nil)
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
	resp = get("/nested?q=1", true, s.preview.origin)
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
	if resp.StatusCode != 302 || resp.Header.Get("Location") != s.preview.origin+"/assets/module.js" {
		t.Fatal("local redirect not rewritten")
	}
	current := &serverBrowser{s: s, cookie: b.cookie}
	current.acquire(t, "", true)
	resp = get("/nested", true, "")
	resp.Body.Close()
	if resp.StatusCode != 410 {
		t.Fatal("revoked preview still available")
	}
}

func TestWebPreviewWebSocketAndStreamingRevokeOnTakeover(t *testing.T) {
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
	conn, _, err := websocket.Dial(ctx, strings.Replace(s.preview.origin, "http:", "ws:", 1)+"/hmr", &websocket.DialOptions{HTTPHeader: http.Header{"Cookie": {cookie.String()}, "Origin": {s.preview.origin}}})
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
	req, _ := http.NewRequest("GET", s.preview.origin+"/stream", nil)
	req.AddCookie(cookie)
	stream, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Body.Close()
	current := &serverBrowser{s: s, cookie: b.cookie}
	current.acquire(t, "", true)
	if _, _, err = conn.Read(ctx); err == nil {
		t.Fatal("revoked socket remained open")
	}
	select {
	case <-streamCanceled:
	case <-ctx.Done():
		t.Fatal("revoked stream remained open")
	}
}

func TestWebPreviewDesktopBearerAndScopedClose(t *testing.T) {
	s := testServer(t)
	workspace, _ := s.service.AddWorkspace(t.TempDir())
	open := func(token string) (*http.Response, wire.WebPreviewResponse) {
		body, _ := json.Marshal(wire.WebPreviewInput{WorkspaceID: workspace.ID, Address: "http://localhost:5173"})
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
	resp, _ := open("")
	if resp.StatusCode != 401 {
		t.Fatal("missing Desktop bearer admitted")
	}
	resp, first := open(s.token)
	if resp.StatusCode != 200 {
		t.Fatal("Desktop preview failed")
	}
	_, second := open(s.token)
	body, _ := json.Marshal(wire.IDInput{ID: first.ID})
	req, _ := http.NewRequest("POST", s.URL+"/api/web-preview/close", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+s.token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	s.preview.mu.Lock()
	current := s.preview.grant.id
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
	// Even with the latest cookie, a retired origin must never control the
	// replacement project. Both Host and cross-origin fetches are rejected.
	for _, test := range []struct{ host, origin string }{{u.Host, "https://" + u.Host}, {next.Host, "https://" + u.Host}} {
		req, _ := http.NewRequest("GET", "http://"+s.preview.listener.Addr().String()+"/", nil)
		req.Host = test.host
		req.Header.Set("Origin", test.origin)
		s.preview.mu.Lock()
		key := s.preview.grant.key
		s.preview.mu.Unlock()
		req.AddCookie(&http.Cookie{Name: previewCookie, Value: key})
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 403 {
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
			req, _ := http.NewRequest("GET", s.preview.origin+"/nested", nil)
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
			conn, _, err := websocket.Dial(ctx, strings.Replace(s.preview.origin, "http:", "ws:", 1)+"/hmr", &websocket.DialOptions{HTTPHeader: http.Header{"Cookie": {cookie.String()}, "Origin": {s.preview.origin}}})
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
