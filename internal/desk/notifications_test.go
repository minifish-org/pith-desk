package desk

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func notificationFixture(t *testing.T) (*Service, Conversation, Workspace, string) {
	t.Helper()
	base := t.TempDir()
	dataDir := filepath.Join(base, "private")
	s, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	folder := filepath.Join(base, "workspace")
	if err := os.Mkdir(folder, 0700); err != nil {
		t.Fatal(err)
	}
	workspace, err := s.AddWorkspace(folder)
	if err != nil {
		t.Fatal(err)
	}
	entry, err := s.CreateConversation(workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	entry = completeNotificationFixture(t, s, entry.ID, "fixture-run")
	return s, entry, workspace, dataDir
}

func completeNotificationFixture(t *testing.T, s *Service, id, runID string) Conversation {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.completeConversationLocked(id, runID); err != nil {
		t.Fatal(err)
	}
	return s.state.Conversations[s.conversationIndexLocked(id)]
}

func TestCompletionNotificationSurvivesRestartAndSelectsCorrectWorkspace(t *testing.T) {
	s, entry, workspace, dataDir := notificationFixture(t)
	target, _, err := s.RememberCompletionNotification(entry, workspace)
	if err != nil {
		t.Fatal(err)
	}
	// Leave the application looking at an unrelated workspace before exit.
	folder := filepath.Join(filepath.Dir(dataDir), "other-workspace")
	if err := os.Mkdir(folder, 0700); err != nil {
		t.Fatal(err)
	}
	other, err := s.AddWorkspace(folder)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateConversation(other.ID); err != nil {
		t.Fatal(err)
	}
	s.Close()
	reopened, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reopened.Close)
	if err := reopened.OpenCompletionNotification(target.ID); err != nil {
		t.Fatal(err)
	}
	state := reopened.Snapshot()
	if state.ActiveID != entry.ID || state.Conversations[reopened.conversationIndexLocked(state.ActiveID)].WorkspaceID != workspace.ID {
		t.Fatalf("old notification selected the wrong session/workspace: %+v", state.Conversations)
	}
	// Viewing/read acknowledgement alone does not invalidate a still-retained
	// notification. Only an actual newer completion replaces its run target.
	if err := reopened.MarkConversationRead(entry.ID, entry.CompletedRunID); err != nil {
		t.Fatal(err)
	}
	if err := reopened.OpenCompletionNotification(target.ID); err != nil {
		t.Fatalf("read acknowledgement expired a valid notification: %v", err)
	}
	if err := reopened.ForgetCompletionNotification(target.ID); err != nil {
		t.Fatal(err)
	}
	if err := reopened.OpenCompletionNotification(target.ID); !errors.Is(err, ErrNotificationUnavailable) {
		t.Fatalf("consumed target was still available: %v", err)
	}
}

func TestCompletionNotificationUnavailableTargetsLeaveCurrentViewUnchanged(t *testing.T) {
	for _, kind := range []string{"deleted", "workspace removed", "expired", "future timestamp", "superseded", "wrong workspace", "unknown"} {
		t.Run(kind, func(t *testing.T) {
			s, entry, workspace, _ := notificationFixture(t)
			target, _, err := s.RememberCompletionNotification(entry, workspace)
			if err != nil {
				t.Fatal(err)
			}
			other, err := s.CreateConversation(workspace.ID)
			if err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "deleted":
				if err := s.DeleteConversation(entry.ID); err != nil {
					t.Fatal(err)
				}
			case "workspace removed":
				if err := s.RemoveWorkspace(workspace.ID, 2); err != nil {
					t.Fatal(err)
				}
			case "superseded":
				completeNotificationFixture(t, s, entry.ID, "newer-run")
			case "expired", "future timestamp", "wrong workspace":
				s.mu.Lock()
				ledger, err := s.readCompletionNotificationsLocked()
				if err == nil {
					switch kind {
					case "expired":
						ledger.Entries[0].CreatedAt = time.Now().Add(-completionNotificationAge)
					case "future timestamp":
						ledger.Entries[0].CreatedAt = time.Now().Add(time.Hour)
					case "wrong workspace":
						ledger.Entries[0].WorkspaceID = "missing-workspace"
					}
					err = s.writeCompletionNotificationsLocked(ledger)
				}
				s.mu.Unlock()
				if err != nil {
					t.Fatal(err)
				}
			case "unknown":
				target.ID = "mygo-old-random-notification"
			}
			before := s.Snapshot().ActiveID
			if err := s.OpenCompletionNotification(target.ID); !errors.Is(err, ErrNotificationUnavailable) {
				t.Fatalf("unavailable target error = %v", err)
			}
			if s.Snapshot().ActiveID != before {
				t.Fatalf("unavailable target replaced the current view %s with %s", other.ID, s.Snapshot().ActiveID)
			}
			if kind == "deleted" {
				if _, err := os.Stat(s.sessionFile(entry.ID)); !os.IsNotExist(err) {
					t.Fatalf("notification recreated a deleted transcript: %v", err)
				}
			}
		})
	}
}

func TestCompletionNotificationLedgerBoundsSupersedesAndPreservesAge(t *testing.T) {
	s, entry, workspace, dataDir := notificationFixture(t)
	first, _, err := s.RememberCompletionNotification(entry, workspace)
	if err != nil {
		t.Fatal(err)
	}
	duplicate, removed, err := s.RememberCompletionNotification(entry, workspace)
	if err != nil || len(removed) != 0 || duplicate.ID != first.ID || !duplicate.CreatedAt.Equal(first.CreatedAt) {
		t.Fatalf("duplicate changed its target or age: %+v %v %v", duplicate, removed, err)
	}
	entry = completeNotificationFixture(t, s, entry.ID, "replacement-run")
	replacement, removed, err := s.RememberCompletionNotification(entry, workspace)
	if err != nil || len(removed) != 1 || removed[0] != first.ID || replacement.ID == first.ID {
		t.Fatalf("new completion failed to replace old target: %+v %v %v", replacement, removed, err)
	}
	var allRemoved []string
	for i := 0; i < completionNotificationLimit+3; i++ {
		entry, err := s.CreateConversation(workspace.ID)
		if err != nil {
			t.Fatal(err)
		}
		entry = completeNotificationFixture(t, s, entry.ID, fmt.Sprintf("run-%d", i))
		_, removed, err := s.RememberCompletionNotification(entry, workspace)
		if err != nil {
			t.Fatal(err)
		}
		allRemoved = append(allRemoved, removed...)
	}
	if len(allRemoved) != 4 || allRemoved[0] != replacement.ID {
		t.Fatalf("expected oldest targets to be evicted, got %v", allRemoved)
	}
	s.mu.Lock()
	ledger, err := s.readCompletionNotificationsLocked()
	s.mu.Unlock()
	if err != nil || len(ledger.Entries) != completionNotificationLimit {
		t.Fatalf("ledger is unbounded: %d %v", len(ledger.Entries), err)
	}
	info, err := os.Stat(filepath.Join(dataDir, completionNotificationsFile))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("notification targets permissions: %v %v", info, err)
	}
}

func TestCompletionNotificationFailuresNeverSelectOrAcknowledgeTarget(t *testing.T) {
	s, entry, workspace, dataDir := notificationFixture(t)
	target, _, err := s.RememberCompletionNotification(entry, workspace)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateConversation(workspace.ID); err != nil {
		t.Fatal(err)
	}
	active := s.Snapshot().ActiveID
	catalog := filepath.Join(dataDir, "catalog.json")
	bytes, err := os.ReadFile(catalog)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(catalog); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(catalog, 0700); err != nil {
		t.Fatal(err)
	}
	if err := s.OpenCompletionNotification(target.ID); err == nil || errors.Is(err, ErrNotificationUnavailable) {
		t.Fatalf("transient save failure reported as unavailable: %v", err)
	}
	if s.Snapshot().ActiveID != active {
		t.Fatal("failed notification open changed the current view")
	}
	if err := os.Remove(catalog); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(catalog, bytes, 0600); err != nil {
		t.Fatal(err)
	}
	if err := s.OpenCompletionNotification(target.ID); err != nil {
		t.Fatalf("transient failure consumed retryable notification: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, completionNotificationsFile), []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.RememberCompletionNotification(entry, workspace); err == nil {
		t.Fatal("corrupt ledger was silently replaced")
	}
	s.Close()
	if err := s.OpenCompletionNotification(target.ID); err == nil {
		t.Fatal("closed service allowed notification navigation")
	}
}
