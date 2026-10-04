package host

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func featureRequest(t *testing.T, s *Server, method, path string, body any, authenticated bool) (int, string, http.Header) {
	t.Helper()
	var input io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		input = strings.NewReader(string(data))
	}
	req, err := http.NewRequest(method, s.URL+path, input)
	if err != nil {
		t.Fatal(err)
	}
	if authenticated {
		req.Header.Set("Authorization", "Bearer "+s.token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, string(data), resp.Header
}

func TestFeatureEndpointsKeepCommonAuthentication(t *testing.T) {
	s := testServer(t)
	for _, path := range []string{"/api/resources", "/api/artifacts", "/api/mcp", "/api/export", "/api/diagnostics"} {
		if status, _, _ := featureRequest(t, s, "GET", path, nil, false); status != 401 {
			t.Errorf("unauthenticated %s: %d", path, status)
		}
	}
	for _, path := range []string{"/api/export", "/api/queue", "/api/rename", "/api/delete-conversation", "/api/remove-workspace", "/api/create-instructions", "/api/file", "/api/mcp/save", "/api/mcp/remove", "/api/mcp/connect", "/api/mcp/disconnect", "/api/test-connection", "/api/continue", "/api/diagnostics"} {
		if status, _, _ := featureRequest(t, s, "POST", path, map[string]any{}, false); status != 401 {
			t.Errorf("unauthenticated %s: %d", path, status)
		}
	}
	req, _ := http.NewRequest("GET", s.URL+"/api/mcp", nil)
	req.Header.Set("Authorization", "Bearer "+s.token)
	req.Header.Set("Origin", "https://other.example")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatal("foreign origin read connection settings")
	}
}

func TestNativeExportRequiresARecordedConversationAndReportsFailure(t *testing.T) {
	s := testServer(t)
	workspace, err := s.service.AddWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	conversation, err := s.service.CreateConversation(workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	input := map[string]string{"id": conversation.ID}
	if status, body, _ := featureRequest(t, s, "POST", "/api/export", input, true); status != 200 || !strings.Contains(body, `"native":false`) {
		t.Fatalf("preview did not explicitly select download: %d %s", status, body)
	}
	called := 0
	s.SetExportAction(func(markdown string) error {
		called++
		if !strings.HasPrefix(markdown, "# New conversation") {
			t.Error("native export did not receive conversation Markdown")
		}
		return nil // Both a successful save and a canceled dialog are handled.
	})
	if status, body, _ := featureRequest(t, s, "POST", "/api/export", input, true); status != 200 || !strings.Contains(body, `"native":true`) || called != 1 {
		t.Fatalf("native handler was not called once: %d %s, calls=%d", status, body, called)
	}
	if status, _, _ := featureRequest(t, s, "POST", "/api/export", map[string]string{"id": "unknown"}, true); status != 400 || called != 1 {
		t.Fatal("invalid conversation reached native export")
	}
	s.SetExportAction(func(string) error { return errors.New("Save failed") })
	if status, body, _ := featureRequest(t, s, "POST", "/api/export", input, true); status != 400 || !strings.Contains(body, "Save failed") {
		t.Fatalf("save error was hidden: %d %s", status, body)
	}
}

func TestConversationFeatureHTTPAndMarkdownDownload(t *testing.T) {
	s := testServer(t)
	workspace, err := s.service.AddWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	conversation, err := s.service.CreateConversation(workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	if status, body, _ := featureRequest(t, s, "POST", "/api/rename", map[string]any{"id": conversation.ID, "title": "Research notes"}, true); status != 200 {
		t.Fatalf("rename: %d %s", status, body)
	}
	status, markdown, headers := featureRequest(t, s, "GET", "/api/export?id="+url.QueryEscape(conversation.ID), nil, true)
	if status != 200 || !strings.Contains(markdown, "Research notes") || !strings.HasPrefix(headers.Get("Content-Type"), "text/markdown") || !strings.Contains(headers.Get("Content-Disposition"), "attachment") {
		t.Fatalf("export did not deliver named Markdown: %d %s %v", status, markdown, headers)
	}
	if status, _, _ := featureRequest(t, s, "POST", "/api/queue", map[string]any{"id": conversation.ID, "text": "Later", "mode": "steer"}, true); status != 400 {
		t.Fatal("queue accepted without an active task")
	}
}

func TestDeleteAndRemoveHTTPKeepWorkspaceFilesAndRejectStaleConfirmation(t *testing.T) {
	s := testServer(t)
	workspace, err := s.service.AddWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	first, err := s.service.CreateConversation(workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.service.CreateConversation(workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	if status, _, _ := featureRequest(t, s, "POST", "/api/remove-workspace", map[string]any{"id": workspace.ID}, true); status != 400 {
		t.Fatal("workspace removal accepted without a reviewed count")
	}
	if status, _, _ := featureRequest(t, s, "POST", "/api/remove-workspace", map[string]any{"id": workspace.ID, "conversationCount": 1}, true); status != 400 {
		t.Fatal("stale workspace removal accepted")
	}
	if status, body, _ := featureRequest(t, s, "POST", "/api/delete-conversation", map[string]any{"id": first.ID}, true); status != 200 {
		t.Fatalf("delete: %d %s", status, body)
	}
	if st := s.service.Snapshot(); len(st.Conversations) != 1 || st.ActiveID != second.ID {
		t.Fatal("HTTP delete removed wrong conversation")
	}
	if status, _, _ := featureRequest(t, s, "GET", "/api/export?id="+first.ID, nil, true); status != 400 {
		t.Fatal("deleted conversation remained exportable")
	}
	if status, body, _ := featureRequest(t, s, "POST", "/api/remove-workspace", map[string]any{"id": workspace.ID, "conversationCount": 1}, true); status != 200 {
		t.Fatalf("remove: %d %s", status, body)
	}
	if st := s.service.Snapshot(); len(st.Workspaces) != 0 || len(st.Conversations) != 0 || st.ActiveID != "" {
		t.Fatal("HTTP removal left dangling conversations")
	}
	if status, _, _ := featureRequest(t, s, "POST", "/api/archive", map[string]any{"id": first.ID}, true); status != 404 {
		t.Fatal("obsolete archive endpoint still exists")
	}
}

func TestNativeFileActionsAcceptOnlyDiscoveredPaths(t *testing.T) {
	s := testServer(t)
	workspace, err := s.service.AddWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	opened, revealed := make(chan string, 1), make(chan string, 1)
	s.SetFileActions(func(path string) error { opened <- path; return nil }, func(path string) error { revealed <- path; return nil })
	status, body, _ := featureRequest(t, s, "POST", "/api/create-instructions", map[string]any{"workspaceId": workspace.ID}, true)
	if status != 200 {
		t.Fatalf("create instructions: %d %s", status, body)
	}
	var created struct{ Path string }
	if err := json.Unmarshal([]byte(body), &created); err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"open", "reveal"} {
		status, body, _ := featureRequest(t, s, "POST", "/api/file", map[string]any{"kind": "resource", "workspaceId": workspace.ID, "path": created.Path, "action": action}, true)
		if status != 200 {
			t.Fatalf("%s instructions: %d %s", action, status, body)
		}
	}
	if <-opened != created.Path || <-revealed != created.Path {
		t.Fatal("native callbacks received an unexpected path")
	}
	outside := filepath.Join(t.TempDir(), "private.txt")
	if err := os.WriteFile(outside, []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"resource", "artifact", "unknown"} {
		status, _, _ := featureRequest(t, s, "POST", "/api/file", map[string]any{"kind": kind, "workspaceId": workspace.ID, "path": outside, "action": "open"}, true)
		if status != 400 {
			t.Fatalf("arbitrary %s file reached native shell: %d", kind, status)
		}
	}
	select {
	case <-opened:
		t.Fatal("native shell was called for an arbitrary file")
	default:
	}
}

func TestMCPHTTPConfigurationDoesNotReturnBearerToken(t *testing.T) {
	s := testServer(t)
	secret := "http-fixture-token-private"
	input := map[string]any{"name": "notes", "type": "http", "url": "https://tools.example/mcp", "args": []string{}, "enabled": false, "bearerToken": secret}
	if status, body, _ := featureRequest(t, s, "POST", "/api/mcp/save", input, true); status != 200 {
		t.Fatalf("MCP save: %d %s", status, body)
	}
	status, body, _ := featureRequest(t, s, "GET", "/api/mcp", nil, true)
	if status != 200 || strings.Contains(body, secret) || !strings.Contains(body, `"hasBearerToken":true`) {
		t.Fatalf("MCP public config: %d %s", status, body)
	}
	if status, body, _ := featureRequest(t, s, "POST", "/api/mcp/remove", map[string]string{"name": "notes"}, true); status != 200 {
		t.Fatalf("MCP remove: %d %s", status, body)
	}
}

func TestDiagnosticsNativeSaveAndPreviewRemainExplicit(t *testing.T) {
	s := testServer(t)
	status, body, _ := featureRequest(t, s, "POST", "/api/diagnostics", map[string]any{}, true)
	if status != 200 || !strings.Contains(body, `"native":false`) {
		t.Fatalf("preview route: %d %s", status, body)
	}
	status, body, header := featureRequest(t, s, "GET", "/api/diagnostics", nil, true)
	if status != 200 || !json.Valid([]byte(body)) || !strings.Contains(header.Get("Content-Disposition"), "diagnostics.json") {
		t.Fatalf("bad download: %d %s", status, body)
	}
	called := false
	s.SetDiagnosticsAction(func(data string) error {
		called = true
		if !json.Valid([]byte(data)) {
			t.Fatal("invalid diagnostic")
		}
		return nil
	})
	status, body, _ = featureRequest(t, s, "POST", "/api/diagnostics", map[string]any{}, true)
	if status != 200 || !called || !strings.Contains(body, `"native":true`) {
		t.Fatal("native cancellation/success fell back to browser")
	}
	s.SetDiagnosticsAction(func(string) error { return errors.New("Save failed") })
	status, body, _ = featureRequest(t, s, "POST", "/api/diagnostics", map[string]any{}, true)
	if status != 400 || !strings.Contains(body, "Save failed") {
		t.Fatal("native diagnostic save failure was hidden")
	}
}
