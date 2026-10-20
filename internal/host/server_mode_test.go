package host

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/minifish-org/pith-desk/internal/desk"
	"github.com/minifish-org/pith-desk/internal/wire"
)

const fixtureServerToken = "server-test-token-0123456789abcdef0123456789"

func testServerMode(t *testing.T, origin string) *Server {
	t.Helper()
	service, err := desk.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s, err := StartServer(service, ServerOptions{Listen: "127.0.0.1:0", Origin: origin, Token: fixtureServerToken})
	if err != nil {
		service.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close(); service.Close() })
	return s
}

func TestServerWorkspaceValidationAndPrivateConnectionMetadata(t *testing.T) {
	s := testServerMode(t, "")
	b := &serverBrowser{s: s}
	b.login(t)
	b.acquire(t, "", false)
	for _, path := range []string{".", "relative/folder", filepath.Join(t.TempDir(), "missing")} {
		resp, data := b.request(t, "POST", "/api/workspaces", wire.PathInput{Path: path}, "")
		if resp.StatusCode != 400 {
			t.Fatalf("invalid server path %q: %d %s", path, resp.StatusCode, data)
		}
	}
	folder := t.TempDir()
	resp, data := b.request(t, "POST", "/api/workspaces", wire.PathInput{Path: folder}, "")
	if resp.StatusCode != 200 {
		t.Fatalf("server directory: %d %s", resp.StatusCode, data)
	}
	if err := s.service.ConfigureProvider(desk.ProviderConnectionInput{Provider: "deepseek", BaseURL: "https://api.deepseek.com", APIKey: "PRIVATE_PROVIDER_KEY"}); err != nil {
		t.Fatal(err)
	}
	if err := s.service.SaveMCP(desk.MCPInput{Name: "remote-auth", Type: "http", URL: "https://example.invalid/mcp", OAuth: true, Enabled: true, BearerToken: "PRIVATE_MCP_TOKEN"}); err != nil {
		t.Fatal(err)
	}
	if err := s.service.SaveMCP(desk.MCPInput{Name: "server-command", Type: "stdio", Command: "echo", Enabled: true, Env: map[string]string{"API_TOKEN": "PRIVATE_ENV_VALUE"}}); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/state", "/api/models", "/api/mcp"} {
		resp, data = b.request(t, "GET", path, nil, "")
		if resp.StatusCode != 200 || strings.Contains(string(data), "PRIVATE_") {
			t.Fatalf("unsafe %s: %d %s", path, resp.StatusCode, data)
		}
		if path == "/api/models" {
			var catalog desk.ModelCatalog
			if err := json.Unmarshal(data, &catalog); err != nil {
				t.Fatal(err)
			}
			found := false
			for _, provider := range catalog.Providers {
				if provider.ID == "openai-codex" {
					found = provider.OAuth
				}
			}
			if !found {
				t.Fatal("remote device login was hidden")
			}
		}
		if path == "/api/mcp" && (!bytes.Contains(data, []byte(`"oauth":true`)) || !bytes.Contains(data, []byte("API_TOKEN"))) {
			t.Fatalf("saved OAuth or env metadata lost: %s", data)
		}
	}
	for path, input := range map[string]any{"/api/oauth/start": wire.ProviderInput{Provider: "not-a-remote-flow"}, "/api/mcp/oauth/start": wire.NameInput{Name: "remote-auth"}} {
		resp, data = b.request(t, "POST", path, input, "")
		if resp.StatusCode != 400 {
			t.Fatalf("unavailable sign-in: %d %s", resp.StatusCode, data)
		}
	}
}

func TestServerHandoffRetiresAdmittedWritesWaitingForCommit(t *testing.T) {
	s := testServerMode(t, "")
	old := &serverBrowser{s: s}
	old.login(t)
	old.acquire(t, "", false)
	s.access.mu.Lock()
	lease := s.access.lease
	s.access.mu.Unlock()
	s.operations.Lock()
	locked := true
	defer func() {
		if locked {
			s.operations.Unlock()
		}
	}()
	written := make(chan int, 1)
	go func() {
		response, _ := old.request(t, "POST", "/api/appearance", wire.AppearanceInput{Mode: desk.AppearanceDark}, "100")
		written <- response.StatusCode
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		s.access.mu.Lock()
		admitted := lease.requests[100] != nil
		s.access.mu.Unlock()
		if admitted {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("write did not reach the commit gate")
		}
		time.Sleep(time.Millisecond)
	}
	current := &serverBrowser{s: s, cookie: old.cookie}
	taken := make(chan struct{})
	go func() { current.acquire(t, "", true); close(taken) }()
	select {
	case <-lease.ctx.Done(): // Revocation must precede waiting for the commit gate.
	case <-time.After(5 * time.Second):
		t.Fatal("takeover did not revoke the old lease immediately")
	}
	response, body := old.request(t, "POST", "/api/server/lease", wire.ServerLeaseInput{Resume: old.lease}, "")
	if response.StatusCode != 409 {
		t.Fatalf("old reload raced the explicit handoff: %d %s", response.StatusCode, body)
	}
	s.operations.Unlock()
	locked = false
	select {
	case status := <-written:
		if status != 409 {
			t.Fatalf("retired write: %d", status)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("retired write stalled")
	}
	select {
	case <-taken:
	case <-time.After(5 * time.Second):
		t.Fatal("handoff stalled")
	}
	response, body = current.request(t, "POST", "/api/appearance", wire.AppearanceInput{Mode: desk.AppearanceLight}, "")
	if response.StatusCode != 200 || s.service.Snapshot().Settings.Appearance != desk.AppearanceLight {
		t.Fatalf("replacement write: %d %s", response.StatusCode, body)
	}
}

type serverBrowser struct {
	s      *Server
	cookie *http.Cookie
	lease  string
	seq    atomic.Uint64
}

func (b *serverBrowser) request(t *testing.T, method, path string, input any, number string) (*http.Response, []byte) {
	t.Helper()
	var body io.Reader
	if input != nil {
		data, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		body = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, "http://"+b.s.listener.Addr().String()+path, body)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = strings.TrimPrefix(strings.TrimPrefix(b.s.URL, "https://"), "http://")
	req.Header.Set("Origin", b.s.URL)
	req.Header.Set("Content-Type", "application/json")
	if b.cookie != nil {
		req.AddCookie(b.cookie)
	}
	req.Header.Set("X-Desk-Lease", b.lease)
	if number == "" {
		number = strconv.FormatUint(b.seq.Add(1), 10)
	}
	req.Header.Set("X-Desk-Request", number)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	return resp, data
}

func (b *serverBrowser) login(t *testing.T) {
	t.Helper()
	resp, data := b.request(t, "POST", "/api/server/login", wire.ServerLoginInput{Token: fixtureServerToken}, "")
	if resp.StatusCode != 200 {
		t.Fatalf("login: %d %s", resp.StatusCode, data)
	}
	b.cookie = resp.Cookies()[0]
}

func (b *serverBrowser) acquire(t *testing.T, resume string, takeover bool) {
	t.Helper()
	resp, data := b.request(t, "POST", "/api/server/lease", wire.ServerLeaseInput{Resume: resume, Takeover: takeover}, "")
	if resp.StatusCode != 200 {
		t.Fatalf("acquire: %d %s", resp.StatusCode, data)
	}
	var result wire.ServerLeaseResponse
	if err := json.Unmarshal(data, &result); err != nil || len(result.Lease) != 64 || result.ExpiresIn != 45 {
		t.Fatalf("lease response: %s %v", data, err)
	}
	b.lease = result.Lease
	b.seq.Store(0)
}

func TestServerNeverBootstrapsDesktopCredentialsAndProtectsEveryRoute(t *testing.T) {
	s := testServerMode(t, "")
	b := &serverBrowser{s: s}
	resp, data := b.request(t, "GET", "/", nil, "")
	if resp.StatusCode != 200 || s.token != "" || strings.Contains(string(data), fixtureServerToken) || !strings.Contains(string(data), `name="desk-mode" content="server"`) || !strings.Contains(string(data), `name="desk-token" content=""`) {
		t.Fatalf("unsafe Server bootstrap: %d %s", resp.StatusCode, data)
	}
	for _, phase := range []string{"anonymous", "signed-in-without-lease", "revoked"} {
		if phase == "signed-in-without-lease" {
			b.login(t)
		}
		if phase == "revoked" {
			b.acquire(t, "", false)
			other := &serverBrowser{s: s}
			other.login(t)
			other.acquire(t, "", true)
		}
		for _, endpoint := range wire.Endpoints {
			if strings.HasPrefix(endpoint.Path, "/api/server/") {
				continue
			}
			resp, data := b.request(t, endpoint.Method, endpoint.Path, map[string]any{}, "")
			want := 409
			if phase == "anonymous" {
				want = 401
			}
			if resp.StatusCode != want {
				t.Fatalf("%s %s %s: %d want %d: %s", phase, endpoint.Method, endpoint.Path, resp.StatusCode, want, data)
			}
		}
	}
	// A token in the old Preview's header or URL is never a Server login.
	for _, path := range []string{"/api/state", "/api/state?token=" + fixtureServerToken} {
		req, _ := http.NewRequest("GET", s.URL+path, nil)
		req.Header.Set("Authorization", "Bearer "+fixtureServerToken)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 401 {
			t.Fatal("desktop authentication escaped into Server")
		}
	}
}

func TestServerLeaseRefreshTakeoverExpiryAndStreams(t *testing.T) {
	s := testServerMode(t, "")
	b := &serverBrowser{s: s}
	b.login(t)
	if !b.cookie.HttpOnly || b.cookie.SameSite != http.SameSiteStrictMode || b.cookie.Secure {
		t.Fatalf("local cookie policy: %+v", b.cookie)
	}
	b.acquire(t, "", false)
	old := b.lease
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, strings.Replace(s.URL, "http:", "ws:", 1)+"/api/socket", &websocket.DialOptions{
		HTTPHeader: http.Header{"Cookie": []string{b.cookie.String()}, "Origin": []string{s.URL}}, Subprotocols: []string{"pith-desk", "lease." + old},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if conn.Subprotocol() != "pith-desk" {
		t.Fatal("lease credential was echoed")
	}
	if _, _, err := conn.Read(ctx); err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", s.URL+"/api/events", nil)
	req.AddCookie(b.cookie)
	req.Header.Set("X-Desk-Lease", old)
	stream, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Body.Close()
	reader := bufio.NewReader(stream.Body)
	for range 3 {
		if _, err := reader.ReadString('\n'); err != nil {
			t.Fatal(err)
		}
	}
	other := &serverBrowser{s: s, cookie: b.cookie}
	resp, _ := other.request(t, "POST", "/api/server/lease", wire.ServerLeaseInput{}, "")
	if resp.StatusCode != 409 {
		t.Fatal("second tab acquired without consent")
	}
	b.acquire(t, old, false) // Refresh rotates the credential and disconnects the old page.
	if b.lease == old {
		t.Fatal("refresh reused the page credential")
	}
	if _, _, err := conn.Read(ctx); err == nil {
		t.Fatal("old websocket survived refresh")
	}
	if _, err := reader.ReadString('\n'); err != io.EOF {
		t.Fatalf("old SSE survived refresh: %v", err)
	}
	other.acquire(t, "", true)
	resp, _ = b.request(t, "POST", "/api/server/heartbeat", wire.EmptyInput{}, "")
	if resp.StatusCode != 409 {
		t.Fatal("takeover did not revoke old page")
	}
	s.access.mu.Lock()
	s.access.lease.expires = time.Now().Add(-time.Second)
	s.access.mu.Unlock()
	resp, _ = other.request(t, "GET", "/api/state", nil, "")
	if resp.StatusCode != 409 {
		t.Fatal("expired lease still admitted reads")
	}
	b.acquire(t, "", false) // Timeout releases ownership without cooperation.
	resp, _ = b.request(t, "POST", "/api/server/logout", wire.EmptyInput{}, "")
	if resp.StatusCode != 200 {
		t.Fatal("logout failed")
	}
	resp, _ = b.request(t, "GET", "/api/state", nil, "")
	if resp.StatusCode != 401 {
		t.Fatal("logout retained a valid session")
	}
}

func TestServerProxyOriginCSRFAndCookiePolicy(t *testing.T) {
	s := testServerMode(t, "https://desk.example.test")
	b := &serverBrowser{s: s}
	b.login(t)
	if !b.cookie.Secure || !b.cookie.HttpOnly || b.cookie.SameSite != http.SameSiteStrictMode {
		t.Fatalf("remote cookie policy: %+v", b.cookie)
	}
	b.acquire(t, "", false)
	resp, data := b.request(t, "GET", "/api/state", nil, "")
	if resp.StatusCode != 200 || !strings.Contains(resp.Header.Get("Content-Security-Policy"), "wss://desk.example.test") {
		t.Fatalf("proxy request: %d %s", resp.StatusCode, data)
	}
	for _, tc := range []struct{ host, origin, site string }{
		{"127.0.0.1", s.URL, "same-origin"}, {"evil.test", s.URL, "same-origin"},
		{"desk.example.test", "https://evil.test", "same-origin"}, {"desk.example.test", s.URL, "cross-site"},
		{"desk.example.test", "", "same-origin"},
	} {
		req := httptest.NewRequest("POST", "/api/server/login", strings.NewReader(`{"token":"`+fixtureServerToken+`"}`))
		req.Host = tc.host
		req.Header.Set("Origin", tc.origin)
		req.Header.Set("Sec-Fetch-Site", tc.site)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Forwarded-Host", "desk.example.test")
		req.Header.Set("X-Forwarded-Proto", "https")
		w := httptest.NewRecorder()
		s.serve(w, req)
		if w.Code != 403 {
			t.Fatalf("accepted forged origin/host: %+v: %d", tc, w.Code)
		}
	}
	for _, origin := range []string{"http://0.0.0.0:7540", "http://192.168.1.2:7540", "https://user@desk.test", "https://desk.test/path", "https://desk.test?token=x"} {
		if server, err := StartServer(nil, ServerOptions{Listen: "127.0.0.1:0", Origin: origin, Token: fixtureServerToken}); err == nil {
			server.Close()
			t.Fatalf("unsafe origin accepted: %s", origin)
		}
	}
}

func TestServerMutationReceiptsAndDownloads(t *testing.T) {
	s := testServerMode(t, "")
	b := &serverBrowser{s: s}
	b.login(t)
	b.acquire(t, "", false)
	workspace, err := s.service.AddWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	input := wire.WorkspaceInput{WorkspaceID: workspace.ID}
	resp, first := b.request(t, "POST", "/api/conversations", input, "1")
	if resp.StatusCode != 200 {
		t.Fatalf("create: %d %s", resp.StatusCode, first)
	}
	resp, again := b.request(t, "POST", "/api/conversations", input, "1")
	if resp.StatusCode != 200 || !bytes.Equal(first, again) || len(s.service.Snapshot().Conversations) != 1 {
		t.Fatalf("mutation replayed: %d %s", resp.StatusCode, again)
	}
	var duplicates sync.WaitGroup
	for range 8 {
		duplicates.Go(func() {
			resp, replay := b.request(t, "POST", "/api/conversations", input, "1")
			if resp.StatusCode != 200 || !bytes.Equal(first, replay) {
				t.Errorf("concurrent replay: %d %s", resp.StatusCode, replay)
			}
		})
	}
	duplicates.Wait()
	if len(s.service.Snapshot().Conversations) != 1 {
		t.Fatal("concurrent duplicate created a conversation")
	}
	resp, _ = b.request(t, "POST", "/api/conversations", wire.WorkspaceInput{WorkspaceID: "different"}, "1")
	if resp.StatusCode != 409 {
		t.Fatal("accepted a reused operation number with changed body")
	}
	for i := 2; i <= 70; i++ {
		resp, _ = b.request(t, "POST", "/api/appearance", wire.AppearanceInput{Mode: desk.AppearanceDark}, strconv.Itoa(i))
		if resp.StatusCode != 200 {
			t.Fatal("receipt window update failed")
		}
	}
	resp, _ = b.request(t, "POST", "/api/conversations", input, "1")
	if resp.StatusCode != 409 || len(s.service.Snapshot().Conversations) != 1 {
		t.Fatal("evicted request was executed again")
	}
	id := s.service.Snapshot().ActiveID
	if err := os.WriteFile(filepath.Join(workspace.Path, "report 中文.txt"), []byte("downloaded from server\n"), 0600); err != nil {
		t.Fatal(err)
	}
	resp, data := b.request(t, "GET", "/api/conversation-file?id="+id+"&path=report%20%E4%B8%AD%E6%96%87.txt", nil, "")
	if resp.StatusCode != 200 || string(data) != "downloaded from server\n" || !strings.Contains(resp.Header.Get("Content-Disposition"), "attachment") {
		t.Fatalf("download: %d %s", resp.StatusCode, data)
	}
	resp, _ = b.request(t, "GET", "/api/conversation-file?id="+id+"&path=../secret", nil, "")
	if resp.StatusCode == 200 {
		t.Fatal("download escaped workspace")
	}
}

type pausedRequestBody struct {
	entered chan struct{}
	resume  chan struct{}
	reader  io.Reader
	once    sync.Once
}

func (b *pausedRequestBody) Read(data []byte) (int, error) {
	b.once.Do(func() { close(b.entered) })
	<-b.resume
	return b.reader.Read(data)
}
func (*pausedRequestBody) Close() error { return nil }

func TestServerTakeoverDuringSlowUploadRejectsTheOldMutation(t *testing.T) {
	s := testServerMode(t, "")
	b := &serverBrowser{s: s}
	b.login(t)
	b.acquire(t, "", false)
	workspace, err := s.service.AddWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	body := &pausedRequestBody{entered: make(chan struct{}), resume: make(chan struct{}), reader: strings.NewReader(`{"workspaceId":"` + workspace.ID + `"}`)}
	req := httptest.NewRequest("POST", s.URL+"/api/conversations", body)
	req.AddCookie(b.cookie)
	req.Header.Set("X-Desk-Lease", b.lease)
	req.Header.Set("X-Desk-Request", "1")
	w := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { defer close(done); s.serve(w, req) }()
	<-body.entered
	other := &serverBrowser{s: s, cookie: b.cookie}
	other.acquire(t, "", true)
	close(body.resume)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("old upload did not finish")
	}
	if w.Code != 409 || len(s.service.Snapshot().Conversations) != 0 {
		t.Fatalf("stale upload mutated the service: %d %s", w.Code, w.Body.String())
	}
}

func TestServerHTTPSReverseProxyAuthenticatesHTTPAndWebSocket(t *testing.T) {
	proxy := httptest.NewUnstartedServer(nil)
	s := testServerMode(t, "https://"+proxy.Listener.Addr().String())
	backend, _ := url.Parse("http://" + s.listener.Addr().String())
	proxy.Config.Handler = httputil.NewSingleHostReverseProxy(backend) // Preserve the browser Host.
	proxy.StartTLS()
	t.Cleanup(proxy.Close)
	client := proxy.Client()
	client.Jar, _ = cookiejar.New(nil)
	post := func(path, body string) *http.Response {
		req, _ := http.NewRequest("POST", proxy.URL+path, strings.NewReader(body))
		req.Header.Set("Origin", proxy.URL)
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}
	resp := post("/api/server/login", `{"token":"`+fixtureServerToken+`"}`)
	resp.Body.Close()
	if resp.StatusCode != 200 || !resp.Cookies()[0].Secure {
		t.Fatal("HTTPS proxy login failed")
	}
	resp = post("/api/server/lease", `{}`)
	var lease wire.ServerLeaseResponse
	if err := json.NewDecoder(resp.Body).Decode(&lease); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	req, _ := http.NewRequest("GET", proxy.URL+"/api/state", nil)
	req.Header.Set("X-Desk-Lease", lease.Lease)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("HTTPS cookie/lease failed: %d", resp.StatusCode)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, strings.Replace(proxy.URL, "https:", "wss:", 1)+"/api/socket", &websocket.DialOptions{HTTPClient: client, HTTPHeader: http.Header{"Origin": []string{proxy.URL}}, Subprotocols: []string{"pith-desk", "lease." + lease.Lease}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if _, _, err := conn.Read(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestServerLoginRateLimitAndSessionExpiry(t *testing.T) {
	s := testServerMode(t, "")
	b := &serverBrowser{s: s}
	for range 10 {
		resp, _ := b.request(t, "POST", "/api/server/login", wire.ServerLoginInput{Token: "wrong"}, "")
		if resp.StatusCode != 401 {
			t.Fatal("invalid token accepted")
		}
	}
	resp, _ := b.request(t, "POST", "/api/server/login", wire.ServerLoginInput{Token: fixtureServerToken}, "")
	if resp.StatusCode != 429 || resp.Header.Get("Retry-After") == "" {
		t.Fatal("login was not rate limited")
	}
	s.access.mu.Lock()
	s.access.loginWindow = time.Now().Add(-time.Minute)
	s.access.mu.Unlock()
	b.login(t)
	b.acquire(t, "", false)
	s.access.mu.Lock()
	s.access.sessions[b.cookie.Value] = time.Now().Add(-time.Second)
	s.access.mu.Unlock()
	resp, _ = b.request(t, "GET", "/api/state", nil, "")
	if resp.StatusCode != 401 {
		t.Fatal("expired session still authorized")
	}
}

func TestServerTaskSurvivesBrowserDisconnectRefreshAndDuplicateSubmission(t *testing.T) {
	var requests atomic.Int32
	entered, release := make(chan struct{}), make(chan struct{})
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		close(entered)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		select {
		case <-r.Context().Done():
			return
		case <-release:
		}
		fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Finished offline\"}}]}\n\n")
		fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	t.Cleanup(provider.Close)
	s := testServerMode(t, "")
	if err := s.service.Configure(desk.ConfigInput{BaseURL: provider.URL + "/v1", Model: "deepseek-flash", APIKey: "fixture-provider-key"}); err != nil {
		t.Fatal(err)
	}
	workspace, err := s.service.AddWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	conversation, err := s.service.CreateConversation(workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	b := &serverBrowser{s: s}
	b.login(t)
	b.acquire(t, "", false)
	input := wire.SendInput{ID: conversation.ID, Text: "Keep working after disconnect"}
	resp, data := b.request(t, "POST", "/api/send", input, "1")
	if resp.StatusCode != 200 {
		t.Fatalf("send: %d %s", resp.StatusCode, data)
	}
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("task did not reach provider")
	}
	resp, _ = b.request(t, "POST", "/api/send", input, "1")
	if resp.StatusCode != 200 || requests.Load() != 1 {
		t.Fatal("repeated submission started a second task")
	}
	// Browser ownership expires while the provider is still streaming.
	s.access.mu.Lock()
	s.access.lease.expires = time.Now().Add(-time.Second)
	s.access.expireLocked()
	s.access.mu.Unlock()
	if !s.service.Snapshot().Running {
		t.Fatal("disconnect canceled the task")
	}
	close(release)
	deadline := time.Now().Add(5 * time.Second)
	for s.service.Snapshot().Running && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	b.acquire(t, "", false)
	resp, data = b.request(t, "GET", "/api/state", nil, "")
	var state desk.State
	if err := json.Unmarshal(data, &state); err != nil || resp.StatusCode != 200 || state.Running || requests.Load() != 1 || len(state.Messages) != 2 || state.Messages[1].Text != "Finished offline" {
		t.Fatalf("reconnected state: %d %s, requests %d: %v", resp.StatusCode, data, requests.Load(), err)
	}
}
