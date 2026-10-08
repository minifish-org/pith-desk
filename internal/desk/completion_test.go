package desk

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestCompletionUnreadPersistsAndAcknowledgesExactRun(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		startSSE(w)
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": "Done"}}}})
		finishSSE(w, "stop")
	}))
	defer provider.Close()
	s, _, dataDir := configuredService(t, provider.URL)
	if err := s.Send("First task"); err != nil {
		t.Fatal(err)
	}
	st := waitState(t, s, func(st State) bool { return !st.Running })
	id, first := st.ActiveID, st.Runtime.RunID
	if st.Conversations[0].CompletedRunID != first || !st.Conversations[0].Unread {
		t.Fatalf("successful task lost completion: %+v", st.Conversations)
	}
	s.Close()
	s, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if !s.Snapshot().Conversations[0].Unread {
		t.Fatal("restart lost unread result")
	}
	if err := s.Send("Second task"); err != nil {
		t.Fatal(err)
	}
	st = waitState(t, s, func(st State) bool { return !st.Running })
	second := st.Runtime.RunID
	if second == first || st.Conversations[0].CompletedRunID != second {
		t.Fatal("completion identity was reused")
	}
	if err := s.MarkConversationRead(id, first); err != nil {
		t.Fatal(err)
	}
	if !s.Snapshot().Conversations[0].Unread {
		t.Fatal("late acknowledgement hid the new result")
	}
	if err := s.MarkConversationRead(id, second); err != nil {
		t.Fatal(err)
	}
	if s.Snapshot().Conversations[0].Unread {
		t.Fatal("viewed result remained unread")
	}
	s.Close()
	reopened, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if reopened.Snapshot().Conversations[0].Unread || reopened.Snapshot().Conversations[0].CompletedRunID != second {
		t.Fatal("read acknowledgement was not persisted")
	}
}

func TestStoppedTaskDoesNotProduceCompletion(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		startSSE(w)
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": "Working"}}}})
		<-req.Context().Done()
	}))
	defer provider.Close()
	s, _, _ := configuredService(t, provider.URL)
	defer s.Close()
	if err := s.Send("Hold"); err != nil {
		t.Fatal(err)
	}
	st := waitState(t, s, func(st State) bool { return countText(st.Messages, "Working") > 0 })
	if err := s.AbortConversation(st.ActiveID); err != nil {
		t.Fatal(err)
	}
	st = waitState(t, s, func(st State) bool { return !st.Running })
	if st.Conversations[0].CompletedRunID != "" || st.Conversations[0].Unread {
		t.Fatal("stopped task was reported as completed")
	}
}

func TestFailedTaskDoesNotProduceCompletion(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"message":"invalid fixture request","type":"invalid_request_error"}}`))
	}))
	defer provider.Close()
	s, _, _ := configuredService(t, provider.URL)
	defer s.Close()
	if err := s.Send("Fail"); err != nil {
		t.Fatal(err)
	}
	st := waitState(t, s, func(st State) bool { return !st.Running })
	if st.Runtime.Phase != "error" || st.Conversations[0].CompletedRunID != "" || st.Conversations[0].Unread {
		t.Fatalf("failed task was reported as completed: %+v", st)
	}
}

func TestReadPersistenceFailureKeepsUnread(t *testing.T) {
	s, _, dataDir := configuredService(t, "http://127.0.0.1:1")
	defer s.Close()
	s.mu.Lock()
	id := s.state.ActiveID
	err := s.completeConversationLocked(id, "completed-run")
	s.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	catalog := filepath.Join(dataDir, "catalog.json")
	if err := os.Remove(catalog); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(catalog, 0700); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkConversationRead(id, "completed-run"); err == nil {
		t.Fatal("failed persistence was hidden")
	}
	if !s.Snapshot().Conversations[0].Unread {
		t.Fatal("failed acknowledgement hid the unread result")
	}
}
