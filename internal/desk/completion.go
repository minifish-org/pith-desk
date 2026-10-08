package desk

import "errors"

// Completion is committed only after the durable task and its tools settle.
// Keep the last successful run in the catalog so coalesced snapshots, refreshes
// and restarts cannot lose the unread marker.
func (s *Service) completeConversationLocked(id, runID string) error {
	index := s.conversationIndexLocked(id)
	if index < 0 || runID == "" {
		return nil
	}
	previous := s.state.Conversations[index]
	s.state.Conversations[index].CompletedRunID = runID
	s.state.Conversations[index].Unread = true
	if err := s.persistCatalogLocked(); err != nil {
		s.state.Conversations[index] = previous
		return err
	}
	return nil
}

// MarkConversationRead acknowledges exactly the result the user has viewed.
// An acknowledgement from an older snapshot must not hide a newer result.
func (s *Service) MarkConversationRead(id, runID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errors.New("The application is closing")
	}
	index := s.conversationIndexLocked(id)
	if index < 0 {
		return errors.New("Conversation not found")
	}
	entry := &s.state.Conversations[index]
	if runID == "" || entry.CompletedRunID != runID || !entry.Unread {
		return nil
	}
	entry.Unread = false
	if err := s.persistCatalogLocked(); err != nil {
		entry.Unread = true
		return err
	}
	s.changedLocked()
	return nil
}
