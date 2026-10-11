package desk

import (
	"strings"
	"testing"
)

func TestUpdatePausesNewTasksButPreservesDraftSaves(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	w, err := s.AddWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	conversation, err := s.CreateConversation(w.ID)
	if err != nil {
		t.Fatal(err)
	}
	resume, err := s.PauseTaskAdmission()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.PauseTaskAdmission(); err == nil {
		t.Fatal("concurrent updater was admitted")
	}
	if err := s.SendConversation(conversation.ID, "hello"); err == nil || !strings.Contains(err.Error(), "updating") {
		t.Fatalf("new task was admitted: %v", err)
	}
	if err := s.QueueMessage(conversation.ID, "queued", ""); err == nil || !strings.Contains(err.Error(), "updating") {
		t.Fatalf("queue was admitted: %v", err)
	}
	if _, err := s.SaveDraft(DraftInput{DraftScope: DraftScope{ID: conversation.ID}, Draft: Draft{Text: "unsent", Revision: 1}}); err != nil {
		t.Fatal(err)
	}
	resume()
	resume()
	if err := s.SendConversation(conversation.ID, "hello"); err != nil && strings.Contains(err.Error(), "updating") {
		t.Fatal("canceled update did not restore admission")
	}
}
