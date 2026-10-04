package host

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/minifish-org/pith-desk/internal/desk"
)

func testServer(t *testing.T) *Server {
	t.Helper()
	service, err := desk.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s, err := Start(service, nil)
	if err != nil {
		service.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close(); service.Close() })
	return s
}

func TestWebSocketSnapshotsRequireHeaderCredential(t *testing.T) {
	s := testServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	url := strings.Replace(s.URL, "http://", "ws://", 1) + "/api/socket"
	if conn, resp, err := websocket.Dial(ctx, url, nil); err == nil {
		conn.CloseNow()
		t.Fatal("socket accepted unauthenticated request")
	} else if resp == nil || resp.StatusCode != 401 {
		t.Fatalf("unexpected socket rejection: %v", err)
	}
	conn, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{Subprotocols: []string{"pith-desk", "bearer." + s.token}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if conn.Subprotocol() != "pith-desk" {
		t.Fatal("server echoed the credential protocol")
	}
	if _, _, err = conn.Read(ctx); err != nil {
		t.Fatal(err)
	}
	if err = s.service.Configure(desk.ConfigInput{BaseURL: "https://api.deepseek.com/v1", Model: "deepseek-flash", APIKey: "socket-private-key"}); err != nil {
		t.Fatal(err)
	}
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "socket-private-key") || !strings.Contains(string(data), `"hasApiKey":true`) {
		t.Fatalf("socket update incorrect: %s", data)
	}
	badHeaders := http.Header{"Origin": []string{"https://example.com"}}
	if conn, resp, err := websocket.Dial(ctx, url, &websocket.DialOptions{Subprotocols: []string{"pith-desk", "bearer." + s.token}, HTTPHeader: badHeaders}); err == nil {
		conn.CloseNow()
		t.Fatal("foreign origin accepted")
	} else if resp == nil || resp.StatusCode != 403 {
		t.Fatalf("unexpected origin rejection: %v", err)
	}
}

func TestLoopbackAuthenticationAndOrigin(t *testing.T) {
	s := testServer(t)
	for _, tc := range []struct {
		name, path, token, origin, host string
		want                            int
	}{
		{"unauthenticated", "/api/state", "", "", "", 401},
		{"authenticated", "/api/state", s.token, "", "", 200},
		{"foreign origin", "/api/state", s.token, "https://example.com", "", 403},
		{"rebound host", "/api/state", s.token, "", "evil.test", 403},
		{"workspace not webroot", "/etc/passwd", "", "", "", 404},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req, _ := http.NewRequest("GET", s.URL+tc.path, nil)
			if tc.token != "" {
				req.Header.Set("Authorization", "Bearer "+tc.token)
			}
			req.Header.Set("Origin", tc.origin)
			if tc.host != "" {
				req.Host = tc.host
			}
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != tc.want {
				t.Fatalf("status %d, want %d", resp.StatusCode, tc.want)
			}
		})
	}
	resp, err := http.Get(s.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), s.token) || strings.Contains(string(body), "__DESK_TOKEN__") {
		t.Fatal("index bootstrap token missing")
	}
	if resp.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("credential bootstrap can be cached")
	}
	if !strings.Contains(resp.Header.Get("Content-Security-Policy"), "frame-ancestors 'none'") {
		t.Fatal("missing framing restriction")
	}
}

func TestSnapshotsStreamAndPrivateCredentials(t *testing.T) {
	s := testServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", s.URL+"/api/events", nil)
	req.Header.Set("Authorization", "Bearer "+s.token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	scanner := bufio.NewScanner(resp.Body)
	readState := func() string {
		t.Helper()
		for scanner.Scan() {
			line := scanner.Text()
			if strings.HasPrefix(line, "data: ") {
				return strings.TrimPrefix(line, "data: ")
			}
		}
		t.Fatalf("stream ended: %v", scanner.Err())
		return ""
	}
	var initial map[string]any
	if err = json.Unmarshal([]byte(readState()), &initial); err != nil {
		t.Fatal(err)
	}
	body := `{"baseUrl":"https://api.deepseek.com/v1","model":"deepseek-flash","apiKey":"private-test-secret"}`
	req, _ = http.NewRequestWithContext(ctx, "POST", s.URL+"/api/config", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+s.token)
	updated, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer updated.Body.Close()
	if updated.StatusCode != 200 {
		b, _ := io.ReadAll(updated.Body)
		t.Fatalf("configure: %s", b)
	}
	next := readState()
	if strings.Contains(next, "private-test-secret") {
		t.Fatal("credential exposed in public stream")
	}
	var state struct {
		Settings struct {
			HasAPIKey bool `json:"hasApiKey"`
		} `json:"settings"`
	}
	if err = json.Unmarshal([]byte(next), &state); err != nil {
		t.Fatal(err)
	}
	if !state.Settings.HasAPIKey {
		t.Fatal("missing settings change snapshot")
	}
}

func TestPermissionEndpointsRequireAuthAndValidateActiveConversation(t *testing.T) {
	s := testServer(t)
	workspace, err := s.service.AddWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	conversation, err := s.service.CreateConversation(workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	post := func(path string, value any, authenticated bool) (int, string) {
		t.Helper()
		body, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		request, _ := http.NewRequest(http.MethodPost, s.URL+path, strings.NewReader(string(body)))
		if authenticated {
			request.Header.Set("Authorization", "Bearer "+s.token)
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		output, _ := io.ReadAll(response.Body)
		return response.StatusCode, string(output)
	}
	payload := map[string]any{"id": conversation.ID, "mode": "full-access"}
	if code, _ := post("/api/permissions", payload, false); code != http.StatusUnauthorized {
		t.Fatal("unauthenticated request changed permissions")
	}
	if code, output := post("/api/permissions", map[string]any{"id": conversation.ID, "mode": "workspace-write"}, true); code != http.StatusOK {
		t.Fatalf("valid permission request failed: %d, %s", code, output)
	}
	if mode := s.service.Snapshot().Conversations[0].PermissionMode; mode != desk.PermissionWorkspaceWrite {
		t.Fatalf("HTTP permission endpoint did not update the conversation: %s", mode)
	}
	if code, _ := post("/api/permissions", map[string]any{"id": "inactive", "mode": "full-access"}, true); code != http.StatusBadRequest {
		t.Fatal("permissions changed for an unknown or inactive conversation")
	}
	if code, _ := post("/api/permissions", map[string]any{"id": conversation.ID, "mode": "unknown"}, true); code != http.StatusBadRequest {
		t.Fatal("invalid permission mode was accepted")
	}
	code, output := post("/api/approval", map[string]any{"id": "stale", "allow": true, "alwaysAllow": true}, true)
	if code != http.StatusBadRequest || !strings.Contains(output, "no longer pending") {
		t.Fatalf("scoped approval field was not decoded or validated: %d, %s", code, output)
	}
	if mode := s.service.Snapshot().Conversations[0].PermissionMode; mode != desk.PermissionWorkspaceWrite {
		t.Fatal("a stale HTTP approval acquired a broader grant")
	}
}

func TestAppearanceEndpointAuthAndNonsecretHTMLBootstrap(t *testing.T) {
	s := testServer(t)
	if !strings.Contains(string(s.index), `data-appearance="__DESK_APPEARANCE__"`) {
		t.Fatal("embedded frontend index is missing the appearance bootstrap placeholder")
	}
	if err := s.service.Configure(desk.ConfigInput{BaseURL: "https://api.deepseek.com/v1", Model: "deepseek-flash", APIKey: "appearance-private-key"}); err != nil {
		t.Fatal(err)
	}
	postAppearance := func(mode string, authenticated bool) int {
		t.Helper()
		body, _ := json.Marshal(map[string]string{"mode": mode})
		request, _ := http.NewRequest(http.MethodPost, s.URL+"/api/appearance", strings.NewReader(string(body)))
		if authenticated {
			request.Header.Set("Authorization", "Bearer "+s.token)
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		return response.StatusCode
	}
	if code := postAppearance("dark", false); code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated theme change returned %d", code)
	}
	if s.service.Snapshot().Settings.Appearance != desk.AppearanceSystem {
		t.Fatal("unauthenticated request changed appearance")
	}
	if code := postAppearance("dark", true); code != http.StatusOK {
		t.Fatalf("valid appearance change returned %d", code)
	}
	if code := postAppearance(`dark" onclick="bad`, true); code != http.StatusBadRequest {
		t.Fatal("invalid appearance value was accepted into HTML bootstrap")
	}
	response, err := http.Get(s.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `data-appearance="dark"`) || strings.Contains(string(body), "__DESK_APPEARANCE__") {
		t.Fatalf("saved theme was not available before UI startup: %s", body)
	}
	if strings.Contains(string(body), "appearance-private-key") || strings.Contains(string(body), "api.deepseek.com") {
		t.Fatal("HTML appearance bootstrap exposed provider configuration or credentials")
	}
}

func TestNativeAppearanceCallbackRunsOnlyAfterSuccessfulPersistence(t *testing.T) {
	dataDir := t.TempDir()
	service, err := desk.New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	changed := make(chan desk.AppearanceMode, 3)
	s, err := Start(service, nil, func(mode desk.AppearanceMode) { changed <- mode })
	if err != nil {
		service.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close(); service.Close() })
	post := func(mode string) int {
		t.Helper()
		body, _ := json.Marshal(map[string]string{"mode": mode})
		request, _ := http.NewRequest(http.MethodPost, s.URL+"/api/appearance", strings.NewReader(string(body)))
		request.Header.Set("Authorization", "Bearer "+s.token)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		return response.StatusCode
	}
	if code := post("light"); code != http.StatusOK {
		t.Fatalf("successful preference update returned %d", code)
	}
	select {
	case mode := <-changed:
		if mode != desk.AppearanceLight {
			t.Fatalf("native appearance callback received %q", mode)
		}
	default:
		t.Fatal("saved preference did not update the native appearance")
	}
	settingsFile := filepath.Join(dataDir, "settings.json")
	saved, err := os.ReadFile(settingsFile)
	if err != nil {
		t.Fatal(err)
	}
	var config struct{ Appearance desk.AppearanceMode }
	if err := json.Unmarshal(saved, &config); err != nil || config.Appearance != desk.AppearanceLight {
		t.Fatalf("callback ran without saving the preference: %s, %v", saved, err)
	}
	if code := post("invalid"); code != http.StatusBadRequest {
		t.Fatal("invalid preference was accepted")
	}
	if err := os.Remove(settingsFile); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(settingsFile, 0o700); err != nil {
		t.Fatal(err)
	}
	if code := post("dark"); code != http.StatusBadRequest {
		t.Fatal("failed preference persistence was reported as successful")
	}
	select {
	case mode := <-changed:
		t.Fatalf("failed preference update changed the native appearance to %q", mode)
	default:
	}
	if service.Snapshot().Settings.Appearance != desk.AppearanceLight {
		t.Fatal("failed save changed the public preference")
	}
}
