package host

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/minifish-org/pith-desk/internal/desk"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
)

func TestClipboardTextRequiresAuthenticationAndReportsNativeErrors(t *testing.T) {
	s := testServer(t)
	text := "# Reply\n\nA **complete** response."
	var copied []string
	s.SetClipboardActions(func(value string) error { copied = append(copied, value); return nil }, nil)
	if status, _, _ := featureRequest(t, s, http.MethodPost, "/api/copy-text", map[string]string{"text": text}, false); status != http.StatusUnauthorized || len(copied) != 0 {
		t.Fatal("unauthenticated input reached the clipboard")
	}
	if status, body, _ := featureRequest(t, s, http.MethodPost, "/api/copy-text", map[string]string{"text": text}, true); status != http.StatusOK || len(copied) != 1 || copied[0] != text {
		t.Fatalf("copy changed the response: %d %s %+v", status, body, copied)
	}
	s.SetClipboardActions(func(string) error { return errors.New("Clipboard unavailable") }, nil)
	if status, body, _ := featureRequest(t, s, http.MethodPost, "/api/copy-text", map[string]string{"text": text}, true); status != http.StatusBadRequest || !strings.Contains(body, "Clipboard unavailable") {
		t.Fatalf("native failure was hidden: %d %s", status, body)
	}
	s.SetClipboardActions(nil, nil)
	if status, body, _ := featureRequest(t, s, http.MethodPost, "/api/copy-text", map[string]string{"text": text}, true); status != http.StatusBadRequest || !strings.Contains(body, "browser preview") {
		t.Fatalf("preview pretended to copy: %d %s", status, body)
	}
}

func TestClipboardFileCopiesOnlyRecordedCurrentArtifacts(t *testing.T) {
	s, id, path := clipboardArtifactServer(t)
	input := map[string]string{"kind": "artifact", "id": id, "path": path, "action": "copy"}
	var copied []string
	s.SetClipboardActions(func(string) error { return nil }, func(value string) error { copied = append(copied, value); return nil })
	if status, _, _ := featureRequest(t, s, http.MethodPost, "/api/file", input, false); status != http.StatusUnauthorized || len(copied) != 0 {
		t.Fatal("unauthenticated file reached the clipboard")
	}
	if status, body, _ := featureRequest(t, s, http.MethodPost, "/api/file", input, true); status != http.StatusOK || len(copied) != 1 || copied[0] != path {
		t.Fatalf("recorded artifact did not copy: %d %s %+v", status, body, copied)
	}
	s.SetClipboardActions(nil, func(string) error { return errors.New("File clipboard unavailable") })
	if status, body, _ := featureRequest(t, s, http.MethodPost, "/api/file", input, true); status != http.StatusBadRequest || !strings.Contains(body, "File clipboard unavailable") {
		t.Fatalf("file clipboard failure was hidden: %d %s", status, body)
	}
	s.SetClipboardActions(nil, nil)
	if status, body, _ := featureRequest(t, s, http.MethodPost, "/api/file", input, true); status != http.StatusBadRequest || !strings.Contains(body, "desktop app") {
		t.Fatalf("preview pretended to copy a file: %d %s", status, body)
	}
	copied = nil
	s.SetClipboardActions(nil, func(value string) error { copied = append(copied, value); return nil })
	unrecorded := filepath.Join(filepath.Dir(path), "unrecorded.txt")
	if err := os.WriteFile(unrecorded, []byte("not produced by the conversation"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, mutation := range []map[string]string{
		{"kind": "artifact", "id": id, "path": unrecorded, "action": "copy"},
		{"kind": "artifact", "id": "missing", "path": path, "action": "copy"},
		{"kind": "resource", "path": path, "action": "copy"},
	} {
		if status, _, _ := featureRequest(t, s, http.MethodPost, "/api/file", mutation, true); status != http.StatusBadRequest {
			t.Fatalf("unverified file copy accepted: %d %+v", status, mutation)
		}
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if status, _, _ := featureRequest(t, s, http.MethodPost, "/api/file", input, true); status != http.StatusBadRequest {
		t.Fatal("missing artifact reached clipboard")
	}
	outside := filepath.Join(t.TempDir(), "outside.txt")
	if err := os.WriteFile(outside, []byte("outside"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, path); err != nil {
		t.Fatal(err)
	}
	if status, _, _ := featureRequest(t, s, http.MethodPost, "/api/file", input, true); status != http.StatusBadRequest || len(copied) != 0 {
		t.Fatal("changed or unverified artifact reached clipboard")
	}
}

func clipboardArtifactServer(t *testing.T) (*Server, string, string) {
	t.Helper()
	dataDir := t.TempDir()
	service, err := desk.New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	s, err := Start(service, nil)
	if err != nil {
		service.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close(); service.Close() })
	workspace, err := service.AddWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	conversation, err := service.CreateConversation(workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(workspace.Path, "result.txt")
	if err := os.WriteFile(path, []byte("generated result\n"), 0600); err != nil {
		t.Fatal(err)
	}
	sessionPath := filepath.Join(dataDir, "sessions", conversation.ID+".jsonl")
	if err := os.MkdirAll(filepath.Dir(sessionPath), 0700); err != nil {
		t.Fatal(err)
	}
	version := codingagent.CurrentSessionVersion
	header, _ := json.Marshal(codingagent.SessionHeader{Type: "session", Version: &version, ID: conversation.ID, Timestamp: time.Now().UTC().Format(time.RFC3339Nano), Cwd: workspace.Path})
	if err := os.WriteFile(sessionPath, append(header, '\n'), 0600); err != nil {
		t.Fatal(err)
	}
	manager, err := codingagent.OpenSession(sessionPath)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	args, _ := json.Marshal(map[string]string{"path": "result.txt"})
	assistant := aitypes.NewAssistantMessage(aitypes.ApiOpenAICompletions, "fixture", "offline", 1)
	assistant.StopReason = aitypes.StopReasonToolUse
	assistant.Content = []aitypes.ContentBlock{aitypes.ToolCallBlock(aitypes.NewToolCall("write", "write_file", args))}
	for _, message := range []any{
		aitypes.NewAssistantMessageVariant(assistant),
		aitypes.NewToolResultMessageVariant(aitypes.NewToolResultMessage("write", "write_file", []aitypes.ContentBlock{aitypes.TextBlock("Written")}, false, 2)),
	} {
		payload, err := json.Marshal(message)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := manager.AppendMessage(payload); err != nil {
			t.Fatal(err)
		}
	}
	return s, conversation.ID, path
}
