package host

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
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
