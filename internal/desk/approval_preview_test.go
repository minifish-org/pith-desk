package desk

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	codingagent "github.com/minifish-org/pith/packages/coding-agent"
)

func TestApprovalPreviewUsesSDKMultiEditsAndNeverWritesBeforeApproval(t *testing.T) {
	s, workspace, _, _ := productFeatureService(t)
	path := filepath.Join(workspace.Path, "note.md")
	before := "\ufeffone\r\ntwo\r\nthree\r\n"
	if err := os.WriteFile(path, []byte(before), 0644); err != nil {
		t.Fatal(err)
	}
	policy, err := newFilePolicy(workspace.Path, s.dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer policy.root.Close()
	preview, review := fileApprovalPreview(policy, "edit_file", json.RawMessage(`{"path":"note.md","edits":[{"oldText":"one","newText":"ONE"},{"oldText":"three","newText":"THREE"}]}`))
	if preview.Error != "" || !strings.Contains(preview.Diff, "+ONE") || !strings.Contains(preview.Diff, "-three") || review == nil || !review.unchanged() {
		t.Fatalf("bad multi-edit preview: %+v", preview)
	}
	if content, _ := os.ReadFile(path); string(content) != before {
		t.Fatal("preview modified the file")
	}
	create, createReview := fileApprovalPreview(policy, "write_file", json.RawMessage(`{"path":"new.txt","content":"hello"}`))
	if create.Error != "" || create.Kind != "create" || !strings.Contains(create.Diff, "+hello") || !createReview.unchanged() {
		t.Fatalf("bad create preview: %+v", create)
	}
	if err := os.WriteFile(filepath.Join(workspace.Path, "new.txt"), []byte("created elsewhere"), 0644); err != nil {
		t.Fatal(err)
	}
	if createReview.unchanged() {
		t.Fatal("new file appeared without invalidating review")
	}
	for _, args := range []string{`{"path":"../outside","content":"x"}`, `{"path":"note.md","edits":[{"oldText":"missing","newText":"x"}]}`} {
		tool := "edit_file"
		if strings.Contains(args, "content") {
			tool = "write_file"
		}
		bad, _ := fileApprovalPreview(policy, tool, json.RawMessage(args))
		if bad.Error == "" {
			t.Fatalf("invalid preview accepted: %+v", bad)
		}
	}
}

func TestApprovalChangedFileRequiresAnotherReviewBeforePermissionGrant(t *testing.T) {
	s, workspace, _, _ := productFeatureService(t)
	path := filepath.Join(workspace.Path, "note.txt")
	if err := os.WriteFile(path, []byte("original"), 0644); err != nil {
		t.Fatal(err)
	}
	policy, err := newFilePolicy(workspace.Path, s.dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer policy.root.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- s.active.requestApproval(ctx, codingagent.ToolCall{Name: "write_file", Arguments: json.RawMessage(`{"path":"note.txt","content":"proposed"}`)}, policy)
	}()
	state := waitState(t, s, func(state State) bool { return state.PendingApproval != nil })
	id := state.PendingApproval.ID
	if err := os.WriteFile(path, []byte("changed externally"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := s.DecideApprovalWithScope(id, true, true); err == nil {
		t.Fatal("stale preview approved")
	}
	state = s.Snapshot()
	if state.Conversations[0].PermissionMode != PermissionAsk || state.PendingApproval == nil || state.PendingApproval.ID == id || !strings.Contains(state.PendingApproval.Preview.Diff, "-changed externally") {
		t.Fatalf("stale preview granted scope or wasn't refreshed: %+v", state.PendingApproval)
	}
	if err := s.DecideApproval(id, true); err == nil {
		t.Fatal("old approval identifier still accepted")
	}
	if err := s.DecideApproval(state.PendingApproval.ID, true); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
