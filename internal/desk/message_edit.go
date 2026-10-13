package desk

import (
	"encoding/json"
	"errors"

	agenttypes "github.com/minifish-org/pith/packages/agent/types"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
)

// EditMessage admits a new run before changing the saved branch. The execution
// rewinds before the original user message and preserves its image attachments.
// The old suffix stays available in history; it is never part of the new prompt.
func (s *Service) EditMessage(id, messageID, expectedLastMessageID, text string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if id == "" || id != s.catalog.ActiveID {
		return errors.New("The conversation changed; reopen the message before editing")
	}
	if err := s.conversationIdleLocked(id); err != nil {
		return err
	}
	messages := s.active.Messages
	if len(messages) == 0 || expectedLastMessageID == "" || messages[len(messages)-1].ID != expectedLastMessageID {
		return errors.New("The conversation changed; reopen the message before editing")
	}
	manager, err := s.readConversationSessionLocked(id)
	if err != nil {
		return err
	}
	if manager == nil {
		return errors.New("This conversation has no message to edit")
	}
	defer manager.Close()
	for _, entry := range manager.Context() {
		if entry.ID != messageID || entry.Type != "message" {
			continue
		}
		var message agenttypes.AgentMessage
		if json.Unmarshal(entry.Payload, &message) != nil || message.Message == nil || message.Message.User == nil {
			break
		}
		var images []aitypes.ImageContent
		for _, block := range message.Message.User.Content.Blocks {
			if block.Image != nil {
				images = append(images, *block.Image)
			}
		}
		return s.startTaskInputLocked(text, images, false, nil, messageID)
	}
	return errors.New("Select a user message in the current conversation")
}
