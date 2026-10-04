package desk

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	codingagent "github.com/minifish-org/pith/packages/coding-agent"
)

func TestAlwaysAllowGrantsOnlyWorkspaceChangesAndRevokes(t *testing.T) {
	s, registry, folder, _ := permissionService(t)
	conversationID := s.Snapshot().ActiveID
	if mode := activeMode(s.Snapshot()); mode != PermissionAsk {
		t.Fatalf("new conversation mode = %q, want ask", mode)
	}
	first, _ := startTool(t, registry, "write_file", `{"path":"first.txt","content":"first"}`)
	state := waitState(t, s, func(st State) bool { return st.PendingApproval != nil })
	approvalID := state.PendingApproval.ID
	if err := s.DecideApprovalWithScope("stale-approval", true, true); err == nil {
		t.Fatal("a stale approval changed permissions")
	}
	if activeMode(s.Snapshot()) != PermissionAsk {
		t.Fatal("stale approval persisted a workspace grant")
	}
	if err := s.DecideApprovalWithScope(approvalID, true, true); err != nil {
		t.Fatal(err)
	}
	if err := waitTool(t, first).err; err != nil {
		t.Fatal(err)
	}
	if activeMode(s.Snapshot()) != PermissionWorkspaceWrite {
		t.Fatal("Always allow did not save workspace changes mode")
	}
	second, _ := startTool(t, registry, "write_file", `{"path":"second.txt","content":"second"}`)
	if err := waitTool(t, second).err; err != nil {
		t.Fatal(err)
	}
	edit, _ := startTool(t, registry, "edit_file", `{"path":"first.txt","edits":[{"oldText":"first","newText":"edited"}]}`)
	if err := waitTool(t, edit).err; err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(filepath.Join(folder, "first.txt")); err != nil || string(data) != "edited" {
		t.Fatalf("automatic edit failed: %s, %v", data, err)
	}
	shell, _ := startTool(t, registry, "run_command", `{"command":"printf 'shell is still gated'"}`)
	state = waitState(t, s, func(st State) bool { return st.PendingApproval != nil })
	if state.PendingApproval.ToolName != "run_command" {
		t.Fatal("workspace mode did not keep shell gated")
	}
	if err := s.DecideApprovalWithScope(state.PendingApproval.ID, true, true); err == nil {
		t.Fatal("a shell approval acquired the workspace Always allow grant")
	}
	if err := s.DecideApproval(state.PendingApproval.ID, true); err != nil {
		t.Fatal(err)
	}
	if output := waitTool(t, shell); output.err != nil || blockText(output.result.Content) != "shell is still gated" {
		t.Fatalf("one-time shell approval failed: %+v", output)
	}
	if err := s.SetPermissionMode(conversationID, PermissionAsk); err != nil {
		t.Fatal(err)
	}
	revoked, cancel := startTool(t, registry, "write_file", `{"path":"revoked.txt","content":"not allowed yet"}`)
	state = waitState(t, s, func(st State) bool { return st.PendingApproval != nil })
	cancel()
	if err := s.DecideApprovalWithScope(state.PendingApproval.ID, true, true); err == nil {
		t.Fatal("a canceled approval acquired a lasting grant")
	}
	if output := waitTool(t, revoked); !errors.Is(output.err, context.Canceled) {
		t.Fatalf("canceled write returned %v", output.err)
	}
	if _, err := os.Stat(filepath.Join(folder, "revoked.txt")); !os.IsNotExist(err) || activeMode(s.Snapshot()) != PermissionAsk {
		t.Fatal("revoked or canceled action wrote a file or changed permissions")
	}
}

func TestFullAccessPermitsShellWithoutWeakeningFileGuards(t *testing.T) {
	s, registry, _, _ := permissionService(t)
	if err := s.SetPermissionMode(s.Snapshot().ActiveID, PermissionFullAccess); err != nil {
		t.Fatal(err)
	}
	shell, _ := startTool(t, registry, "run_command", `{"command":"printf 'full access selected'"}`)
	if output := waitTool(t, shell); output.err != nil || blockText(output.result.Content) != "full access selected" {
		t.Fatalf("full access still gated shell: %+v", output)
	}
	write, _ := startTool(t, registry, "write_file", `{"path":"../outside.txt","content":"escape"}`)
	if err := waitTool(t, write).err; err == nil {
		t.Fatal("full access weakened workspace file-tool confinement")
	}
	if s.Snapshot().PendingApproval != nil {
		t.Fatal("denied file escape created an approval")
	}
}

func TestPermissionChangesDuringRunResolvePendingAndApplyRevocation(t *testing.T) {
	var requests atomic.Int32
	thirdRequest := make(chan struct{})
	releaseThird := make(chan struct{})
	var releaseOnce sync.Once
	t.Cleanup(func() { releaseOnce.Do(func() { close(releaseThird) }) })
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		startSSE(w)
		var name, args, id string
		switch requests.Add(1) {
		case 1:
			name, args, id = "write_file", `{"path":"approved.txt","content":"saved"}`, "first-write"
		case 2:
			name, args, id = "run_command", `{"command":"printf 'approved command'"}`, "command"
		case 3:
			close(thirdRequest)
			select {
			case <-releaseThird:
			case <-r.Context().Done():
				return
			}
			name, args, id = "write_file", `{"path":"after-revoke.txt","content":"not approved"}`, "later-write"
		default:
			finishSSE(w, "stop")
			return
		}
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{
			"role": "assistant", "tool_calls": []any{map[string]any{"index": 0, "id": id, "type": "function", "function": map[string]any{"name": name, "arguments": args}}},
		}}}})
		finishSSE(w, "tool_calls")
	}))
	t.Cleanup(server.Close)
	s, folder, _ := configuredService(t, server.URL)
	conversationID := s.Snapshot().ActiveID
	if err := s.Send("Make a note and run the requested command"); err != nil {
		t.Fatal(err)
	}
	waitState(t, s, func(st State) bool { return st.PendingApproval != nil && st.PendingApproval.ToolName == "write_file" })
	if err := s.SetPermissionMode(conversationID, PermissionWorkspaceWrite); err != nil {
		t.Fatal(err)
	}
	waitState(t, s, func(st State) bool { return st.PendingApproval != nil && st.PendingApproval.ToolName == "run_command" })
	if _, err := os.Stat(filepath.Join(folder, "approved.txt")); err != nil {
		t.Fatal("workspace grant did not release the pending write")
	}
	if err := s.SetPermissionMode(conversationID, PermissionFullAccess); err != nil {
		t.Fatal(err)
	}
	select {
	case <-thirdRequest:
	case <-time.After(5 * time.Second):
		t.Fatal("full access did not release the pending shell command")
	}
	if err := s.SetPermissionMode(conversationID, PermissionAsk); err != nil {
		t.Fatal(err)
	}
	releaseOnce.Do(func() { close(releaseThird) })
	state := waitState(t, s, func(st State) bool { return st.PendingApproval != nil })
	if state.PendingApproval.ToolName != "write_file" {
		t.Fatalf("later action ignored revocation: %+v", state.PendingApproval)
	}
	s.Abort()
	if err := s.DecideApprovalWithScope(state.PendingApproval.ID, true, true); err == nil {
		t.Fatal("Abort left an approval capable of acquiring a persistent grant")
	}
	state = waitState(t, s, func(st State) bool { return !st.Running })
	if activeMode(state) != PermissionAsk || state.PendingApproval != nil {
		t.Fatalf("aborted task changed permission state: %+v", state)
	}
	if _, err := os.Stat(filepath.Join(folder, "after-revoke.txt")); !os.IsNotExist(err) {
		t.Fatal("the revoked action wrote its unapproved file")
	}
}

func TestPermissionModesPersistPerConversationAndLegacyDefaultsAreSafe(t *testing.T) {
	s, _, _, dataDir := permissionService(t)
	first := s.Snapshot().ActiveID
	workspace := s.Snapshot().Workspaces[0]
	if err := s.SetPermissionMode(first, PermissionFullAccess); err != nil {
		t.Fatal(err)
	}
	second, err := s.CreateConversation(workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	if second.PermissionMode != PermissionAsk {
		t.Fatal("a new conversation inherited full access")
	}
	if err := s.SetPermissionMode(first, PermissionAsk); err == nil {
		t.Fatal("permissions changed on an inactive conversation")
	}
	if err := s.SetPermissionMode(second.ID, PermissionMode("unknown")); err == nil {
		t.Fatal("an invalid permission selection was accepted")
	}
	if err := s.SetPermissionMode(second.ID, PermissionWorkspaceWrite); err != nil {
		t.Fatal(err)
	}
	s.Close()
	reopened, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reopened.Close)
	for _, conversation := range reopened.Snapshot().Conversations {
		want := PermissionFullAccess
		if conversation.ID == second.ID {
			want = PermissionWorkspaceWrite
		}
		if conversation.PermissionMode != want {
			t.Fatalf("conversation permission did not survive restart: %+v", conversation)
		}
	}
	reopened.Close()
	var legacy catalogState
	if err := readJSON(filepath.Join(dataDir, "catalog.json"), &legacy); err != nil {
		t.Fatal(err)
	}
	legacy.Conversations[0].PermissionMode = ""
	legacy.Conversations[1].PermissionMode = "invalid-saved-mode"
	if err := writeJSON(filepath.Join(dataDir, "catalog.json"), legacy); err != nil {
		t.Fatal(err)
	}
	legacyService, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(legacyService.Close)
	for _, conversation := range legacyService.Snapshot().Conversations {
		if conversation.PermissionMode != PermissionAsk {
			t.Fatal("missing or invalid saved mode did not default to Ask")
		}
	}
}

func TestPermissionGrantRequiresSuccessfulPersistence(t *testing.T) {
	s, registry, folder, dataDir := permissionService(t)
	write, cancel := startTool(t, registry, "write_file", `{"path":"persist-first.txt","content":"saved"}`)
	defer cancel()
	state := waitState(t, s, func(st State) bool { return st.PendingApproval != nil })
	catalogFile := filepath.Join(dataDir, "catalog.json")
	saved, err := os.ReadFile(catalogFile)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(catalogFile); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(catalogFile, 0700); err != nil {
		t.Fatal(err)
	}
	if err := s.DecideApprovalWithScope(state.PendingApproval.ID, true, true); err == nil {
		t.Fatal("a persistent grant succeeded without saving its catalog")
	}
	if activeMode(s.Snapshot()) != PermissionAsk || s.Snapshot().PendingApproval == nil {
		t.Fatal("failed persistence altered permissions or resolved the action")
	}
	if _, err := os.Stat(filepath.Join(folder, "persist-first.txt")); !os.IsNotExist(err) {
		t.Fatal("an action ran before its permission choice was saved")
	}
	if err := os.Remove(catalogFile); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(catalogFile, saved, 0600); err != nil {
		t.Fatal(err)
	}
	if err := s.DecideApprovalWithScope(state.PendingApproval.ID, true, true); err != nil {
		t.Fatal(err)
	}
	if err := waitTool(t, write).err; err != nil {
		t.Fatal(err)
	}
}

func TestPermissionRecheckedAfterApprovalSerialization(t *testing.T) {
	s, registry, _, _ := permissionService(t)
	first, _ := startTool(t, registry, "write_file", `{"path":"first-in-queue.txt","content":"first"}`)
	state := waitState(t, s, func(st State) bool { return st.PendingApproval != nil })
	second, _ := startTool(t, registry, "write_file", `{"path":"second-in-queue.txt","content":"second"}`)
	if err := s.DecideApprovalWithScope(state.PendingApproval.ID, true, true); err != nil {
		t.Fatal(err)
	}
	if err := waitTool(t, first).err; err != nil {
		t.Fatal(err)
	}
	if err := waitTool(t, second).err; err != nil {
		t.Fatal(err)
	}
	if s.Snapshot().PendingApproval != nil {
		t.Fatal("a queued write kept a stale approval after the workspace grant")
	}
}

type toolOutcome struct {
	result codingagent.ToolResult
	err    error
}

func startTool(t *testing.T, registry *codingagent.ToolRegistry, name, args string) (<-chan toolOutcome, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	result := make(chan toolOutcome, 1)
	go func() {
		output, err := registry.Execute(ctx, codingagent.ToolCall{ID: newID(), Name: name, Arguments: json.RawMessage(args)})
		result <- toolOutcome{output, err}
	}()
	return result, cancel
}

func waitTool(t *testing.T, outcome <-chan toolOutcome) toolOutcome {
	t.Helper()
	select {
	case result := <-outcome:
		return result
	case <-time.After(5 * time.Second):
		t.Fatal("tool did not complete under the selected permission mode")
		return toolOutcome{}
	}
}

func activeMode(state State) PermissionMode {
	for _, conversation := range state.Conversations {
		if conversation.ID == state.ActiveID {
			return conversation.PermissionMode
		}
	}
	return PermissionAsk
}

func permissionService(t *testing.T) (*Service, *codingagent.ToolRegistry, string, string) {
	t.Helper()
	root := t.TempDir()
	folder, dataDir := filepath.Join(root, "workspace"), filepath.Join(root, "private")
	if err := os.Mkdir(folder, 0700); err != nil {
		t.Fatal(err)
	}
	s, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	workspace, err := s.AddWorkspace(folder)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateConversation(workspace.ID); err != nil {
		t.Fatal(err)
	}
	policy, err := newFilePolicy(folder, dataDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = policy.root.Close() })
	registry, err := s.buildTools(policy)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = registry.CloseTools() })
	return s, registry, folder, dataDir
}
