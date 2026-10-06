package desk

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	codingagent "github.com/minifish-org/pith/packages/coding-agent"
	"github.com/minifish-org/pith/packages/mcp"
)

type deskMCPFixture struct {
	server     *httptest.Server
	calls      atomic.Int32
	initialize func(http.ResponseWriter, *http.Request) bool
	call       func(*http.Request) bool
}

func newDeskMCPFixture(t *testing.T, token string, initialize func(http.ResponseWriter, *http.Request) bool) *deskMCPFixture {
	t.Helper()
	f := &deskMCPFixture{initialize: initialize}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusOK)
			return
		}
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if token != "" && r.Header.Get("Authorization") != "Bearer "+token {
			t.Error("MCP credential was not sent to its configured server")
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var request struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if len(request.ID) == 0 {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		var result any
		switch request.Method {
		case "initialize":
			if f.initialize != nil && !f.initialize(w, r) {
				return
			}
			w.Header().Set("Mcp-Session-Id", "desk-fixture")
			result = map[string]any{"protocolVersion": mcp.LatestProtocolVersion, "capabilities": map[string]any{"tools": map[string]any{}}, "serverInfo": map[string]any{"name": "desk-fixture", "version": "1"}}
		case "tools/list":
			result = map[string]any{"tools": []any{map[string]any{"name": "echo", "description": "Echo external arguments", "inputSchema": map[string]any{"type": "object"}}, map[string]any{"name": "fail", "inputSchema": map[string]any{"type": "object"}}}}
		case "resources/list":
			result = map[string]any{"resources": []any{}}
		case "tools/call":
			f.calls.Add(1)
			if f.call != nil && !f.call(r) {
				return
			}
			var params struct {
				Name      string         `json:"name"`
				Arguments map[string]any `json:"arguments"`
			}
			_ = json.Unmarshal(request.Params, &params)
			if params.Name == "fail" {
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": request.ID, "error": map[string]any{"code": -32603, "message": "failed with " + r.Header.Get("Authorization")}})
				return
			}
			text, _ := json.Marshal(params.Arguments)
			result = map[string]any{"content": []any{map[string]any{"type": "text", "text": string(text)}}}
		default:
			result = map[string]any{}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result})
	}))
	t.Cleanup(f.server.Close)
	return f
}

func TestMCPAutoConnectUsesPithAndSeparateExternalPermissions(t *testing.T) {
	connector := newDeskMCPFixture(t, "private-mcp-token", nil)
	var requests atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		tools, _ := json.Marshal(body["tools"])
		if !strings.Contains(string(tools), "mcp__office__echo") {
			t.Error("connected MCP tool was not exposed through Pith")
		}
		startSSE(w)
		// Deferred tools become model-visible after the SDK's search tool.
		var declarations []struct {
			Function struct {
				Name string `json:"name"`
			} `json:"function"`
		}
		_ = json.Unmarshal(tools, &declarations)
		exposed := false
		for _, tool := range declarations {
			exposed = exposed || tool.Function.Name == "mcp__office__echo"
		}
		if !exposed {
			sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "search-external", "type": "function", "function": map[string]any{"name": "tool_search", "arguments": `{"query":"echo"}`}}}}}}})
			finishSSE(w, "tool_calls")
			return
		}
		if number := requests.Add(1); number%2 == 1 {
			sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"index": 0, "id": fmt.Sprintf("external-%d", number), "type": "function", "function": map[string]any{"name": "mcp__office__echo", "arguments": `{"path":"/external/server/document","text":"hello"}`}}}}}}})
			finishSSE(w, "tool_calls")
		} else {
			sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": "MCP complete"}}}})
			finishSSE(w, "stop")
		}
	}))
	t.Cleanup(provider.Close)
	s, _, _ := configuredService(t, provider.URL)
	if err := s.SaveMCP(MCPInput{Name: "office", Type: "http", URL: connector.server.URL, BearerToken: "private-mcp-token", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	id := s.Snapshot().ActiveID
	for i, mode := range []PermissionMode{PermissionWorkspaceWrite, PermissionFullAccess, PermissionAsk} {
		if err := s.SetPermissionMode(id, mode); err != nil {
			t.Fatal(err)
		}
		if err := s.Send("Use the external connector"); err != nil {
			t.Fatal(err)
		}
		if mode != PermissionFullAccess {
			state := waitState(t, s, func(st State) bool { return st.PendingApproval != nil })
			if state.PendingApproval.ToolName != "mcp__office__echo" || !strings.Contains(state.PendingApproval.Warning, "external") {
				t.Fatal("MCP did not receive a separate external approval")
			}
			if connector.calls.Load() != int32(i) {
				t.Fatal("MCP executed before approval")
			}
			if err := s.DecideApprovalWithScope(state.PendingApproval.ID, true, true); err == nil {
				t.Fatal("workspace always-allow granted an external tool")
			}
			if i == 0 {
				if err := s.SaveMCP(MCPInput{Name: "office", Type: "http", URL: connector.server.URL, Enabled: false}); err == nil {
					t.Fatal("active connector configuration changed")
				}
				if err := s.RemoveMCP("office"); err == nil {
					t.Fatal("active connector was removed")
				}
				if err := s.DisconnectMCP(); err == nil {
					t.Fatal("active connector disconnected")
				}
				if err := s.ConnectMCP(context.Background()); err == nil {
					t.Fatal("active connector reconnected")
				}
			}
			if err := s.DecideApproval(state.PendingApproval.ID, true); err != nil {
				t.Fatal(err)
			}
		}
		state := waitState(t, s, func(st State) bool { return !st.Running })
		if state.Error != "" || connector.calls.Load() != int32(i+1) {
			t.Fatalf("MCP run failed: %+v, calls=%d", state, connector.calls.Load())
		}
	}
	views := s.ListMCP()
	if len(views) != 1 || views[0].Status != "connected" || views[0].ToolCount != 2 {
		t.Fatalf("wrong MCP status: %+v", views)
	}
	policy, err := newFilePolicy(s.Snapshot().Workspaces[0].Path, s.dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer policy.root.Close()
	registry, err := s.buildTools(policy)
	if err != nil {
		t.Fatal(err)
	}
	defer registry.CloseTools()
	if err := s.SetPermissionMode(id, PermissionFullAccess); err != nil {
		t.Fatal(err)
	}
	if _, err := registry.ExecuteNested(context.Background(), codingagent.ToolCall{Name: "mcp__office__unknown", Arguments: json.RawMessage(`{}`)}); err == nil {
		t.Fatal("unknown external tool bypassed the allowlist")
	}
	_, err = registry.ExecuteNested(context.Background(), codingagent.ToolCall{Name: "mcp__office__fail", Arguments: json.RawMessage(`{}`)})
	if err == nil || strings.Contains(err.Error(), "private-mcp-token") {
		t.Fatalf("raw MCP error leaked credentials: %v", err)
	}
	public, _ := json.Marshal(s.ListMCP())
	if strings.Contains(string(public), "private-mcp-token") {
		t.Fatal("MCP getter leaked credentials")
	}
}

func TestMCPPrivateConfigurationPersistenceAndAtomicFailure(t *testing.T) {
	s, _, dataDir := configuredService(t, "http://127.0.0.1:1")
	input := MCPInput{Name: "local", Type: "stdio", Command: "offline-command", Args: []string{"--mode", "example"}, Env: map[string]string{"SERVICE_KEY": "private-stdio-value"}, Enabled: false}
	if err := s.SaveMCP(input); err != nil {
		t.Fatal(err)
	}
	input.Env["SERVICE_KEY"] = "mutated-outside-service"
	if err := s.SaveMCP(MCPInput{Name: "local", Type: "stdio", Command: "offline-command", Env: map[string]string{"OTHER": "second-private-value"}, Enabled: false}); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveMCP(MCPInput{Name: "remote", Type: "http", URL: "https://example.com/mcp", BearerToken: "saved-bearer", Enabled: false}); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveMCP(MCPInput{Name: "remote", Type: "http", URL: "https://example.com/mcp", Enabled: false}); err != nil {
		t.Fatal(err)
	}
	if err := s.Configure(ConfigInput{BaseURL: "http://127.0.0.1:2/v1", Model: "deepseek-flash"}); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAppearance(AppearanceDark); err != nil {
		t.Fatal(err)
	}
	public, _ := json.Marshal(s.ListMCP())
	for _, secret := range []string{"private-stdio-value", "second-private-value", "saved-bearer"} {
		if strings.Contains(string(public), secret) {
			t.Fatal("private MCP credential was exposed")
		}
	}
	info, err := os.Stat(filepath.Join(dataDir, "mcp.json"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("MCP configuration is not a private file")
	}
	s.Close()
	reopened, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reopened.Close)
	if views := reopened.ListMCP(); len(views) != 2 || !views[1].HasBearerToken || len(views[0].EnvKeys) != 2 {
		t.Fatalf("MCP settings lost across restart: %+v", views)
	}
	if reopened.mcpConfigs[0].Env["SERVICE_KEY"] != "private-stdio-value" {
		t.Fatal("external map mutation or omitted update erased stored credentials")
	}
	if err := reopened.SaveMCP(MCPInput{Name: "local", Type: "stdio", Command: "offline-command", ClearEnv: true, Env: map[string]string{"NEW": "new-private-value"}}); err != nil {
		t.Fatal(err)
	}
	if views := reopened.ListMCP(); len(views[0].EnvKeys) != 1 || views[0].EnvKeys[0] != "NEW" {
		t.Fatal("clearEnv did not replace saved values")
	}
	if err := reopened.SaveMCP(MCPInput{Name: "remote", Type: "http", URL: "https://example.com/mcp", ClearBearerToken: true}); err != nil {
		t.Fatal(err)
	}
	if reopened.ListMCP()[1].HasBearerToken {
		t.Fatal("explicit token removal failed")
	}
	for _, input := range []MCPInput{{Name: "bad", Type: "stdio", Command: "offline", Env: map[string]string{"": "secret"}}, {Name: "bad", Type: "stdio", Command: "offline", Env: map[string]string{"BAD=KEY": "secret"}}, {Name: "bad", Type: "stdio", Command: "offline", Env: map[string]string{"KEY": "value\x00"}}, {Name: "bad", Type: "http", URL: "https://user:password@example.com/mcp"}} {
		if err := reopened.SaveMCP(input); err == nil {
			t.Fatal("invalid MCP configuration accepted")
		}
	}
	path := filepath.Join(dataDir, "mcp.json")
	saved, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	if err := reopened.RemoveMCP("local"); err == nil {
		t.Fatal("failed save removed a connector from live configuration")
	}
	if len(reopened.ListMCP()) != 2 {
		t.Fatal("failed save changed live MCP state")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, saved, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestMCPConnectCancellationDoesNotHoldServiceLock(t *testing.T) {
	entered := make(chan struct{})
	canceled := make(chan struct{})
	var once sync.Once
	f := newDeskMCPFixture(t, "", func(_ http.ResponseWriter, r *http.Request) bool {
		once.Do(func() { close(entered) })
		<-r.Context().Done()
		close(canceled)
		return false
	})
	s, _, _ := configuredService(t, "http://127.0.0.1:1")
	if err := s.SaveMCP(MCPInput{Name: "slow", Type: "http", URL: f.server.URL, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() { result <- s.ConnectMCP(context.Background()) }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("MCP connect did not begin")
	}
	if err := s.SetAppearance(AppearanceLight); err != nil {
		t.Fatal(err)
	}
	closed := make(chan struct{})
	go func() { s.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown failed to cancel MCP connect")
	}
	if err := <-result; err == nil {
		t.Fatal("canceled connect reported success")
	}
	select {
	case <-canceled:
	case <-time.After(5 * time.Second):
		t.Fatal("MCP HTTP request survived shutdown")
	}
}

func TestMCPToolCallAbortCancelsHTTPAndCanReconnect(t *testing.T) {
	entered, canceled := make(chan struct{}), make(chan struct{})
	var enteredOnce sync.Once
	connector := newDeskMCPFixture(t, "", nil)
	connector.call = func(r *http.Request) bool {
		enteredOnce.Do(func() { close(entered) })
		<-r.Context().Done()
		close(canceled)
		return false
	}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		startSSE(w)
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"index": 0, "id": "slow-external", "type": "function", "function": map[string]any{"name": "codemode", "arguments": `{"code":"return await tools.mcp__slow__echo({});"}`}}}}}}})
		finishSSE(w, "tool_calls")
	}))
	t.Cleanup(provider.Close)
	s, _, _ := configuredService(t, provider.URL)
	if err := s.SaveMCP(MCPInput{Name: "slow", Type: "http", URL: connector.server.URL, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if err := s.SetPermissionMode(s.Snapshot().ActiveID, PermissionFullAccess); err != nil {
		t.Fatal(err)
	}
	if err := s.Send("Call the slow external tool"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("MCP tool call never reached the external server")
	}
	s.Abort()
	state := waitState(t, s, func(st State) bool { return !st.Running })
	if state.Error != "" {
		t.Fatalf("canceled tool run reported an error: %s", state.Error)
	}
	select {
	case <-canceled:
	case <-time.After(5 * time.Second):
		t.Fatal("MCP tool HTTP request survived abort")
	}
	if s.ListMCP()[0].Status != "disconnected" {
		t.Fatal("canceled runtime was retained as a connected tool source")
	}
	if err := s.ConnectMCP(context.Background()); err != nil {
		t.Fatal(err)
	}
	if s.ListMCP()[0].Status != "connected" {
		t.Fatal("a canceled MCP runtime prevented reconnect")
	}
}

func TestMCPStdioUsesExplicitEnvironmentAndCleansUp(t *testing.T) {
	t.Setenv("DEEPSEEK_API_KEY", "ambient-secret")
	t.Setenv("DEMO_AUTH_TOKEN", "ambient-secret")
	s, _, _ := configuredService(t, "http://127.0.0.1:1")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(t.TempDir(), "closed")
	if err := s.SaveMCP(MCPInput{Name: "stdio", Type: "stdio", Command: executable, Args: []string{"-test.run=^TestMCPStdioHelper$", "--", "pith-mcp-stdio-helper", marker}, Env: map[string]string{"SERVICE_KEY": "stdio-only-secret", "HOME": "/tmp/offline-home"}, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.ConnectMCP(ctx); err != nil {
		t.Fatal(err)
	}
	policy, err := newFilePolicy(s.Snapshot().Workspaces[0].Path, s.dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer policy.root.Close()
	registry, err := s.buildTools(policy)
	if err != nil {
		t.Fatal(err)
	}
	defer registry.CloseTools()
	if err := s.SetPermissionMode(s.Snapshot().ActiveID, PermissionFullAccess); err != nil {
		t.Fatal(err)
	}
	result, err := registry.ExecuteNested(ctx, codingagent.ToolCall{Name: "mcp__stdio__env", Arguments: json.RawMessage(`{}`)})
	if err != nil {
		t.Fatal(err)
	}
	if text := blockText(result.Content); text != "true|true|false|false" {
		t.Fatalf("MCP inherited ambient secrets or lost explicit credentials: %q", text)
	}
	_, err = registry.ExecuteNested(ctx, codingagent.ToolCall{Name: "mcp__stdio__fail", Arguments: json.RawMessage(`{}`)})
	if err == nil || strings.Contains(err.Error(), "stdio-only-secret") {
		t.Fatalf("configured environment credential leaked through MCP error: %v", err)
	}
	if err := s.DisconnectMCP(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(marker); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("MCP child did not close after disconnect")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestMCPStdioHelper(t *testing.T) {
	if len(os.Args) < 3 || os.Args[len(os.Args)-2] != "pith-mcp-stdio-helper" {
		return
	}
	marker := os.Args[len(os.Args)-1]
	scanner := bufio.NewScanner(os.Stdin)
	encoder := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		var request struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		if json.Unmarshal(scanner.Bytes(), &request) != nil || len(request.ID) == 0 {
			continue
		}
		var result any
		switch request.Method {
		case "initialize":
			result = map[string]any{"protocolVersion": mcp.LatestProtocolVersion, "capabilities": map[string]any{"tools": map[string]any{}}, "serverInfo": map[string]any{"name": "stdio", "version": "1"}}
		case "tools/list":
			result = map[string]any{"tools": []any{map[string]any{"name": "env", "inputSchema": map[string]any{"type": "object"}}, map[string]any{"name": "fail", "inputSchema": map[string]any{"type": "object"}}}}
		case "resources/list":
			result = map[string]any{"resources": []any{}}
		case "tools/call":
			var full struct {
				Params struct {
					Name string `json:"name"`
				} `json:"params"`
			}
			_ = json.Unmarshal(scanner.Bytes(), &full)
			if full.Params.Name == "fail" {
				_ = encoder.Encode(map[string]any{"jsonrpc": "2.0", "id": request.ID, "error": map[string]any{"code": -32603, "message": "SERVICE_KEY=" + os.Getenv("SERVICE_KEY")}})
				continue
			}
			result = map[string]any{"content": []any{map[string]any{"type": "text", "text": fmt.Sprintf("%t|%t|%t|%t", os.Getenv("SERVICE_KEY") == "stdio-only-secret", os.Getenv("HOME") == "/tmp/offline-home", os.Getenv("DEEPSEEK_API_KEY") != "", os.Getenv("DEMO_AUTH_TOKEN") != "")}}}
		default:
			result = map[string]any{}
		}
		_ = encoder.Encode(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result})
	}
	_ = os.WriteFile(marker, []byte("closed"), 0600)
	os.Exit(0)
}
