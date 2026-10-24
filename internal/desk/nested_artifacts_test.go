package desk

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
)

func TestCodemodeFileChangesKeepApprovalsDiffsAndBranchHistoryAfterRestart(t *testing.T) {
	var calls atomic.Int64
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		startSSE(w)
		n := calls.Add(1)
		if n == 1 {
			code := `try { await tools.write_file({path:"denied.txt",content:"denied"}); } catch {};
await tools.write_file({path:"nested.txt",content:"one\n"});
await tools.edit_file({path:"nested.txt",edits:[{oldText:"one",newText:"two"}]});
try { await tools.edit_file({path:"nested.txt",edits:[{oldText:"missing",newText:"failed"}]}); } catch {};
throw new Error("outer script failed after successful changes");`
			args, _ := json.Marshal(map[string]string{"code": code})
			sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"index": 0, "id": "nested-write", "type": "function", "function": map[string]any{"name": "codemode", "arguments": string(args)}}}}}}})
			finishSSE(w, "tool_calls")
		} else if n == 2 {
			sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"index": 0, "id": "direct-write", "type": "function", "function": map[string]any{"name": "write_file", "arguments": `{"path":"nested.txt","content":"three\n"}`}}}}}}})
			finishSSE(w, "tool_calls")
		} else {
			sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": "Created nested.txt"}}}})
			finishSSE(w, "stop")
		}
	}))
	defer provider.Close()
	s, workspace, dir := configuredService(t, provider.URL)
	id := s.Snapshot().ActiveID
	if err := s.Send("Create and edit a file via codemode"); err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 5; index++ {
		st := waitState(t, s, func(st State) bool { return st.PendingApproval != nil || !st.Running })
		if st.PendingApproval == nil {
			t.Fatalf("missing nested approval %d: %+v", index, st)
		}
		if index < 2 {
			if _, err := os.Stat(filepath.Join(workspace, "nested.txt")); !os.IsNotExist(err) {
				t.Fatal("nested write ran before approval")
			}
		}
		if err := s.DecideApproval(st.PendingApproval.ID, index != 0); err != nil {
			t.Fatal(err)
		}
	}
	st := waitState(t, s, func(st State) bool { return !st.Running })
	if st.Error != "" {
		t.Fatal(st.Error)
	}
	if content, err := os.ReadFile(filepath.Join(workspace, "nested.txt")); err != nil || string(content) != "three\n" {
		t.Fatalf("nested write/edit failed: %q %v", content, err)
	}
	if _, err := os.Stat(filepath.Join(workspace, "denied.txt")); !os.IsNotExist(err) {
		t.Fatal("declined write ran")
	}
	artifacts, err := s.Artifacts(id)
	if err != nil {
		t.Fatal(err)
	}
	if len(artifacts) != 1 || artifacts[0].Name != "nested.txt" || artifacts[0].Additions != 3 || artifacts[0].Deletions != 2 {
		t.Fatalf("nested changes missing or duplicated: %+v", artifacts)
	}
	diff, err := s.DiffArtifact(id, artifacts[0].Path)
	if err != nil || len(diff.Changes) != 3 || !strings.Contains(diff.Changes[0].Patch, "+one") || !strings.Contains(diff.Changes[1].Patch, "-one") || !strings.Contains(diff.Changes[1].Patch, "+two") || !strings.Contains(diff.Changes[2].Patch, "-two") || !strings.Contains(diff.Changes[2].Patch, "+three") {
		t.Fatalf("nested diffs: %+v %v", diff, err)
	}
	first, last := st.Messages[0].ID, st.Messages[len(st.Messages)-1].ID
	s.Close()
	reopened, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	restored, err := reopened.Artifacts(id)
	if err != nil || !reflect.DeepEqual(restored, artifacts) {
		t.Fatalf("restart lost nested artifacts: %+v %v", restored, err)
	}
	restoredDiff, err := reopened.DiffArtifact(id, artifacts[0].Path)
	if err != nil || !reflect.DeepEqual(restoredDiff, diff) {
		t.Fatalf("restart lost nested diffs: %+v %v", restoredDiff, err)
	}
	if err := reopened.BranchConversation(id, first, false); err != nil {
		t.Fatal(err)
	}
	branch, err := reopened.Artifacts(id)
	if err != nil || len(branch) != 0 {
		t.Fatalf("nested changes leaked across branch: %+v %v", branch, err)
	}
	if err := reopened.BranchConversation(id, last, false); err != nil {
		t.Fatal(err)
	}
	branch, err = reopened.Artifacts(id)
	if err != nil || !reflect.DeepEqual(branch, artifacts) {
		t.Fatalf("returning branch lost changes: %+v %v", branch, err)
	}
	if calls.Load() != 3 {
		t.Fatal("restart or branch selection replayed operations")
	}
}
