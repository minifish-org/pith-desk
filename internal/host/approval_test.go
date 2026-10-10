package host

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/minifish-org/pith-desk/internal/desk"
)

func TestApprovalStatusAggregatesRunsAndDeduplicatesChanges(t *testing.T) {
	var values []bool
	s := &Server{approvalAction: func(pending bool) { values = append(values, pending) }}
	state := desk.State{Runs: []desk.RunSummary{{ConversationID: "a", WorkspaceID: "one", NeedsApproval: true}, {ConversationID: "b", WorkspaceID: "two"}}}
	s.updateApprovalLocked(state)
	s.updateApprovalLocked(state)
	state.Runs[1].NeedsApproval = true
	s.updateApprovalLocked(state)
	state.Runs[0].NeedsApproval = false
	s.updateApprovalLocked(state)
	// The selected conversation's approval is irrelevant to other live tasks.
	state.ConversationState.PendingApproval = &desk.Approval{ID: "stale-view"}
	state.Runs = nil
	s.updateApprovalLocked(state)
	if !reflect.DeepEqual(values, []bool{true, false}) {
		t.Fatalf("aggregated approval transitions: %v", values)
	}
	s.clearApprovalAction()
	s.updateApprovalLocked(desk.State{Runs: []desk.RunSummary{{NeedsApproval: true}}})
	if !reflect.DeepEqual(values, []bool{true, false}) || s.approvalAction != nil {
		t.Fatalf("closed host retained its callback: %v", values)
	}
}

func TestApprovalStatusTracksIndependentWorkspacesAndServiceClose(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(approvalFixtureResponse))
	defer provider.Close()
	s := testServer(t)
	if err := s.service.Configure(desk.ConfigInput{BaseURL: provider.URL + "/v1", Model: "deepseek-flash", APIKey: "fixture-key"}); err != nil {
		t.Fatal(err)
	}
	folders := []string{t.TempDir(), t.TempDir()}
	var conversations []desk.Conversation
	for _, folder := range folders {
		w, err := s.service.AddWorkspace(folder)
		if err != nil {
			t.Fatal(err)
		}
		c, err := s.service.CreateConversation(w.ID)
		if err != nil {
			t.Fatal(err)
		}
		conversations = append(conversations, c)
	}
	values := make(chan bool, 16)
	s.SetApprovalAction(func(pending bool) { values <- pending })
	expectApprovalValue(t, values, false)
	if err := s.service.OpenConversation(conversations[0].ID); err != nil {
		t.Fatal(err)
	}
	if err := s.service.SendConversation(conversations[0].ID, "Write the fixture file"); err != nil {
		t.Fatal(err)
	}
	expectApprovalValue(t, values, true)
	state := waitApprovalState(t, s, func(state desk.State) bool {
		return state.PendingApproval != nil && len(state.Runs) == 1
	})
	approvalA := state.PendingApproval.ID
	if err := s.service.OpenConversation(conversations[1].ID); err != nil {
		t.Fatal(err)
	}
	if err := s.service.SendConversation(conversations[1].ID, "Write another fixture file"); err != nil {
		t.Fatal(err)
	}
	waitApprovalState(t, s, func(state desk.State) bool {
		return len(state.Runs) == 2 && state.Runs[0].NeedsApproval && state.Runs[1].NeedsApproval
	})
	// Resolve an approval in the unselected workspace: the other still needs it.
	if err := s.service.DecideApproval(approvalA, true); err != nil {
		t.Fatal(err)
	}
	waitApprovalState(t, s, func(state desk.State) bool {
		return len(state.Runs) == 1 && state.Runs[0].ConversationID == conversations[1].ID && state.Runs[0].NeedsApproval
	})
	if err := s.service.AbortConversation(conversations[1].ID); err != nil {
		t.Fatal(err)
	}
	expectApprovalValue(t, values, false)
	waitApprovalState(t, s, func(state desk.State) bool { return len(state.Runs) == 0 })
	if _, err := os.Stat(filepath.Join(folders[0], "note.txt")); err != nil {
		t.Fatalf("approved fixture file was not written: %v", err)
	}
	if _, err := os.Stat(filepath.Join(folders[1], "note.txt")); !os.IsNotExist(err) {
		t.Fatalf("aborted fixture wrote before approval: %v", err)
	}
	closingConversation, err := s.service.CreateConversation(conversations[1].WorkspaceID)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.service.SendConversation(closingConversation.ID, "Wait for approval again"); err != nil {
		t.Fatal(err)
	}
	expectApprovalValue(t, values, true)
	s.service.Close()
	expectApprovalValue(t, values, false)
}

func approvalFixtureResponse(w http.ResponseWriter, req *http.Request) {
	var in struct {
		Messages []struct {
			Role string `json:"role"`
		} `json:"messages"`
	}
	if err := json.NewDecoder(req.Body).Decode(&in); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	delta := map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"index": 0, "id": "fixture-write", "type": "function", "function": map[string]any{"name": "write_file", "arguments": `{"path":"note.txt","content":"approved fixture"}`}}}}
	finish := "tool_calls"
	for _, message := range in.Messages {
		if message.Role == "tool" {
			delta = map[string]any{"role": "assistant", "content": "Done"}
			finish = "stop"
		}
	}
	w.Header().Set("Content-Type", "text/event-stream")
	first, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": delta}}})
	last, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{}, "finish_reason": finish}}})
	fmt.Fprintf(w, "data: %s\n\ndata: %s\n\ndata: [DONE]\n\n", first, last)
	w.(http.Flusher).Flush()
}

func expectApprovalValue(t *testing.T, values <-chan bool, expected bool) {
	t.Helper()
	select {
	case actual := <-values:
		if actual != expected {
			t.Fatalf("approval value = %v, want %v", actual, expected)
		}
	case <-time.After(10 * time.Second):
		t.Fatalf("approval value %v was not delivered", expected)
	}
}

func waitApprovalState(t *testing.T, s *Server, ready func(desk.State) bool) desk.State {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		state := s.service.Snapshot()
		if ready(state) {
			return state
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("fixture task did not reach the expected state")
	return desk.State{}
}
