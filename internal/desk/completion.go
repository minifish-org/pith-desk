package desk

import "errors"

// Completion is committed only after the durable task and its tools settle.
// Keep the last successful run in the catalog so coalesced snapshots, refreshes
// and restarts cannot lose the unread marker.
func (s *Service) completeConversationLocked(id, runID string) error {
	return s.catalog.complete(id, runID, s.files)
}

// MarkConversationRead acknowledges exactly the result the user has viewed.
// An acknowledgement from an older snapshot must not hide a newer result.
func (s *Service) MarkConversationRead(id, runID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errors.New("The application is closing")
	}
	changed, err := s.catalog.markRead(id, runID, s.files)
	if err != nil {
		return err
	}
	if changed {
		s.changedLocked()
	}
	return nil
}
