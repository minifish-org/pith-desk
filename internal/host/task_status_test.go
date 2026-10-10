package host

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/minifish-org/pith-desk/internal/desk"
)

func TestTaskStatusAggregatesWorkspacesAndDeduplicatesChanges(t *testing.T) {
	var values []TaskStatus
	s := &Server{taskStatusAction: func(status TaskStatus) { values = append(values, status) }}
	state := desk.State{Runs: []desk.RunSummary{{ConversationID: "a", WorkspaceID: "one"}, {ConversationID: "b", WorkspaceID: "two"}}}
	s.updateTaskStatusLocked(state)
	if len(values) != 0 {
		t.Fatalf("ordinary running tasks produced a Dock update: %v", values)
	}
	state.Runs[0].NeedsApproval = true
	s.updateTaskStatusLocked(state)
	s.updateTaskStatusLocked(state)
	state.Runs[1].NeedsApproval = true
	s.updateTaskStatusLocked(state)
	state.Runs[0].NeedsApproval = false
	s.updateTaskStatusLocked(state)
	// The selected conversation's approval is irrelevant to other live tasks.
	state.ConversationState.PendingApproval = &desk.Approval{ID: "stale-view"}
	state.Runs = nil
	state.Conversations = []desk.Conversation{
		{ID: "a", WorkspaceID: "one", CompletedRunID: "run-a", Unread: true},
		{ID: "b", WorkspaceID: "two", CompletedRunID: "run-b", Unread: true},
		{ID: "read", CompletedRunID: "old", Unread: false},
		{ID: "invalid", Unread: true},
	}
	s.updateTaskStatusLocked(state)
	state.Conversations[0].Unread = false
	s.updateTaskStatusLocked(state)
	state.Conversations = nil // Removing a workspace/conversation removes its count.
	s.updateTaskStatusLocked(state)
	want := []TaskStatus{{NeedsApproval: true}, {Unread: 2}, {Unread: 1}, {}}
	if !reflect.DeepEqual(values, want) {
		t.Fatalf("aggregated task transitions: %v, want %v", values, want)
	}
	s.clearTaskStatusAction()
	s.updateTaskStatusLocked(desk.State{Runs: []desk.RunSummary{{NeedsApproval: true}}})
	if !reflect.DeepEqual(values, want) || s.taskStatusAction != nil {
		t.Fatalf("closed host retained its callback: %v", values)
	}
}

func TestTaskStatusTracksRunningApprovalUnreadReadAndServiceClose(t *testing.T) {
	firstRequest := make(chan struct{})
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(firstRequest) }) }
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		<-firstRequest
		approvalFixtureResponse(w, req)
	}))
	defer provider.Close()
	defer release()
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
	values := make(chan TaskStatus, 32)
	s.SetTaskStatusAction(func(status TaskStatus) { values <- status })
	expectTaskStatus(t, values, TaskStatus{})
	if err := s.service.OpenConversation(conversations[0].ID); err != nil {
		t.Fatal(err)
	}
	if err := s.service.SendConversation(conversations[0].ID, "Write the fixture file"); err != nil {
		t.Fatal(err)
	}
	waitApprovalState(t, s, func(state desk.State) bool { return len(state.Runs) == 1 && !state.Runs[0].NeedsApproval })
	release()
	expectTaskStatus(t, values, TaskStatus{NeedsApproval: true})
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
	expectTaskStatus(t, values, TaskStatus{NeedsApproval: true, Unread: 1})
	if err := s.service.AbortConversation(conversations[1].ID); err != nil {
		t.Fatal(err)
	}
	expectTaskStatus(t, values, TaskStatus{Unread: 1})
	waitApprovalState(t, s, func(state desk.State) bool { return len(state.Runs) == 0 })
	// A result from another workspace stays unread until its exact run is viewed.
	if err := s.service.MarkConversationRead(conversations[0].ID, "stale-run"); err != nil {
		t.Fatal(err)
	}
	if actual := summarizeTasks(s.service.Snapshot()); actual != (TaskStatus{Unread: 1}) {
		t.Fatalf("stale acknowledgement cleared unread status: %+v", actual)
	}
	var completedRunID string
	for _, entry := range s.service.Snapshot().Conversations {
		if entry.ID == conversations[0].ID {
			completedRunID = entry.CompletedRunID
		}
	}
	if err := s.service.MarkConversationRead(conversations[0].ID, completedRunID); err != nil {
		t.Fatal(err)
	}
	expectTaskStatus(t, values, TaskStatus{})
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
	expectTaskStatus(t, values, TaskStatus{NeedsApproval: true})
	s.service.Close()
	expectTaskStatus(t, values, TaskStatus{})
}

func TestTaskStatusRestoresUnreadOnStartupAndClearsOnDeleteAndHostClose(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Done\"}}]}\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
		w.(http.Flusher).Flush()
	}))
	defer provider.Close()
	dataDir := t.TempDir()
	service, err := desk.New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(service.Close)
	s, err := Start(service, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	workspace, err := service.AddWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	conversation, err := service.CreateConversation(workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.Configure(desk.ConfigInput{BaseURL: provider.URL + "/v1", Model: "deepseek-flash", APIKey: "fixture-key"}); err != nil {
		t.Fatal(err)
	}
	if err := service.SendConversation(conversation.ID, "Finish"); err != nil {
		t.Fatal(err)
	}
	waitApprovalState(t, s, func(state desk.State) bool { return summarizeTasks(state) == (TaskStatus{Unread: 1}) })
	values := make(chan TaskStatus, 8)
	s.SetTaskStatusAction(func(status TaskStatus) { values <- status })
	expectTaskStatus(t, values, TaskStatus{Unread: 1})
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	expectTaskStatus(t, values, TaskStatus{})
	service.Close()
	reopened, err := desk.New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reopened.Close)
	restarted, err := Start(reopened, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = restarted.Close() })
	restarted.SetTaskStatusAction(func(status TaskStatus) { values <- status })
	expectTaskStatus(t, values, TaskStatus{Unread: 1})
	if err := reopened.DeleteConversation(conversation.ID); err != nil {
		t.Fatal(err)
	}
	expectTaskStatus(t, values, TaskStatus{})
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

func expectTaskStatus(t *testing.T, values <-chan TaskStatus, expected TaskStatus) {
	t.Helper()
	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	for {
		select {
		case actual := <-values:
			if actual == expected {
				return
			}
		case <-timer.C:
			t.Fatalf("task status %+v was not delivered", expected)
		}
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
