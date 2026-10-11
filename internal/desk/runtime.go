package desk

import (
	"errors"

	aitypes "github.com/minifish-org/pith/packages/ai/types"
)

// QueueMessage belongs to the current run only. Pith chooses the next safe
// steering boundary or the point at which it would otherwise finish.
func (s *Service) QueueMessage(id, text, mode string, images ...aitypes.ImageContent) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.restarting {
		return errors.New("Pith Desk is updating; try again after restart")
	}
	r := s.tasks.lookup(id)
	if id == "" || r == nil {
		return errors.New("Conversation not found")
	}
	return r.enqueueLocked(text, mode, images...)
}

// MutateQueuedMessage changes input only while it is still pending. The SDK
// serializes dispatched mutations with delivery; startup/recovered input stays
// under the service lock until it is dispatched. Attachments are preserved.
func (s *Service) MutateQueuedMessage(id, messageID, action, text string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.tasks.lookup(id)
	if id == "" || r == nil {
		return errors.New("Conversation not found")
	}
	return r.mutateQueueLocked(messageID, action, text)
}
