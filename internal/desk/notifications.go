package desk

import (
	"errors"
	"fmt"
	"path/filepath"
	"time"
)

const (
	completionNotificationsFile = "notifications.json"
	completionNotificationLimit = 32
	completionNotificationAge   = 7 * 24 * time.Hour
)

// ErrNotificationUnavailable means that the notification cannot safely select
// a conversation. Its session may have been removed, its result superseded,
// or its retained seven-day entry may have expired.
var ErrNotificationUnavailable = errors.New("This notification has expired or its conversation was removed")

// CompletionNotification is the local target retained independently of a
// native Notification object. The OS receives only ID, never a filesystem path.
type CompletionNotification struct {
	ID             string    `json:"id"`
	ConversationID string    `json:"conversationId"`
	WorkspaceID    string    `json:"workspaceId"`
	RunID          string    `json:"runId"`
	CreatedAt      time.Time `json:"createdAt"`
}

type completionNotificationLedger struct {
	Version int                      `json:"version"`
	Entries []CompletionNotification `json:"entries"`
}

// RememberCompletionNotification saves a target before its system notification
// is shown. Removed IDs are superseded, expired, deleted, or evicted targets
// whose native entries the desktop should close. No service lock is held while
// the OS asks for notification permission.
func (s *Service) RememberCompletionNotification(entry Conversation, workspace Workspace) (CompletionNotification, []string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.rememberCompletionNotificationLocked(entry, workspace, time.Now())
}

func (s *Service) rememberCompletionNotificationLocked(entry Conversation, workspace Workspace, now time.Time) (CompletionNotification, []string, error) {
	if s.closed {
		return CompletionNotification{}, nil, errors.New("Pith Desk has closed")
	}
	target := CompletionNotification{
		ID:             completionNotificationID(entry.ID, entry.CompletedRunID),
		ConversationID: entry.ID, WorkspaceID: workspace.ID, RunID: entry.CompletedRunID, CreatedAt: now.UTC(),
	}
	if !s.validCompletionNotificationLocked(target, now) {
		return CompletionNotification{}, nil, ErrNotificationUnavailable
	}
	ledger, err := s.readCompletionNotificationsLocked()
	if err != nil {
		return CompletionNotification{}, nil, err
	}
	var kept []CompletionNotification
	var removed []string
	for _, existing := range ledger.Entries {
		if existing.ID == target.ID && s.validCompletionNotificationLocked(existing, now) {
			// A duplicate completion does not extend an old notification's age.
			target = existing
			continue
		}
		if existing.ConversationID == target.ConversationID || !s.validCompletionNotificationLocked(existing, now) {
			removed = append(removed, existing.ID)
			continue
		}
		kept = append(kept, existing)
	}
	kept = append(kept, target)
	if len(kept) > completionNotificationLimit {
		for _, existing := range kept[:len(kept)-completionNotificationLimit] {
			removed = append(removed, existing.ID)
		}
		kept = kept[len(kept)-completionNotificationLimit:]
	}
	ledger.Entries = kept
	if err := s.writeCompletionNotificationsLocked(ledger); err != nil {
		return CompletionNotification{}, nil, err
	}
	return target, removed, nil
}

// OpenCompletionNotification resolves the saved target and loads its session
// under one lock. An old or removed target leaves the current view unchanged.
func (s *Service) OpenCompletionNotification(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.availableLocked(); err != nil {
		return err
	}
	ledger, err := s.readCompletionNotificationsLocked()
	if err != nil {
		return err
	}
	for _, target := range ledger.Entries {
		if target.ID == id && s.validCompletionNotificationLocked(target, time.Now()) {
			return s.openConversationLocked(target.ConversationID)
		}
	}
	return ErrNotificationUnavailable
}

// ForgetCompletionNotification acknowledges a consumed or unavailable target.
// Keeping this separate from Open lets a transient load failure remain retryable.
func (s *Service) ForgetCompletionNotification(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errors.New("Pith Desk has closed")
	}
	ledger, err := s.readCompletionNotificationsLocked()
	if err != nil {
		return err
	}
	kept := ledger.Entries[:0]
	for _, target := range ledger.Entries {
		if target.ID != id {
			kept = append(kept, target)
		}
	}
	if len(kept) == len(ledger.Entries) {
		return nil
	}
	ledger.Entries = kept
	return s.writeCompletionNotificationsLocked(ledger)
}

func (s *Service) validCompletionNotificationLocked(target CompletionNotification, now time.Time) bool {
	if target.ConversationID == "" || target.RunID == "" || target.ID != completionNotificationID(target.ConversationID, target.RunID) || target.CreatedAt.IsZero() ||
		target.CreatedAt.After(now) || !target.CreatedAt.Add(completionNotificationAge).After(now) {
		return false
	}
	index := s.conversationIndexLocked(target.ConversationID)
	if index < 0 {
		return false
	}
	entry := s.state.Conversations[index]
	_, exists := s.workspaceLocked(target.WorkspaceID)
	return exists && entry.WorkspaceID == target.WorkspaceID && entry.CompletedRunID == target.RunID
}

func completionNotificationID(conversationID, runID string) string {
	return "pith-desk:completion:" + conversationID + ":" + runID
}

func (s *Service) readCompletionNotificationsLocked() (completionNotificationLedger, error) {
	ledger := completionNotificationLedger{Version: 1}
	if err := readJSON(filepath.Join(s.dataDir, completionNotificationsFile), &ledger); err != nil {
		return ledger, fmt.Errorf("load notification targets: %w", err)
	}
	if ledger.Version != 1 || len(ledger.Entries) > completionNotificationLimit {
		return ledger, errors.New("Invalid notification targets")
	}
	return ledger, nil
}

func (s *Service) writeCompletionNotificationsLocked(ledger completionNotificationLedger) error {
	if err := writeJSON(filepath.Join(s.dataDir, completionNotificationsFile), ledger); err != nil {
		return fmt.Errorf("save notification targets: %w", err)
	}
	return nil
}
