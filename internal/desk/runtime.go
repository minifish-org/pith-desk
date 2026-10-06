package desk

import (
	"errors"
	"fmt"
	"strings"

	aitypes "github.com/minifish-org/pith/packages/ai/types"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
)

type QueueMode string

const (
	QueueSteer    = "steer"
	QueueFollowUp = "follow-up"
)

type QueuedMessage struct {
	ID         string                 `json:"id"`
	Text       string                 `json:"text"`
	Mode       QueueMode              `json:"mode"`
	Images     []aitypes.ImageContent `json:"-"`
	ImageCount int                    `json:"imageCount,omitempty"`
}

// QueueMessage belongs to the current run only. Pith chooses the next safe
// steering boundary or the point at which it would otherwise finish.
func (s *Service) QueueMessage(id, text, mode string, images ...aitypes.ImageContent) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || !s.state.Running || s.aborting || s.queueClosing {
		return errors.New("The task has stopped; send a new message instead")
	}
	if id == "" || id != s.state.ActiveID {
		return errors.New("Queue a message for the active conversation only")
	}
	text = strings.TrimSpace(text)
	if text == "" && len(images) == 0 {
		return errors.New("Write a message or attach an image first")
	}
	if mode == "" {
		mode = QueueFollowUp
	}
	if mode != QueueSteer && mode != QueueFollowUp {
		return errors.New("Choose steer or follow-up")
	}
	model, err := resolveConfiguredModel(s.config)
	if err != nil {
		return err
	}
	images, err = validateImages(images, model)
	if err != nil {
		return err
	}
	message := QueuedMessage{ID: newID(), Text: text, Mode: QueueMode(mode), Images: images, ImageCount: len(images)}
	if err := s.durableQueueLocked("desk.queue", message); err != nil {
		return err
	}
	s.state.QueuedMessages = append(s.state.QueuedMessages, message)
	if s.queueReady && s.session != nil {
		if err := s.dispatchMessageLocked(message); err != nil {
			if rollbackErr := s.durableQueueLocked("desk.delivered", message); rollbackErr != nil {
				s.changedLocked()
				return fmt.Errorf("Message saved for recovery but not queued: %w; %v", err, rollbackErr)
			}
			s.state.QueuedMessages = s.state.QueuedMessages[:len(s.state.QueuedMessages)-1]
			return err
		}
	}
	s.changedLocked()
	return nil
}

// MutateQueuedMessage changes input only while it is still pending. The SDK
// serializes dispatched mutations with delivery; startup/recovered input stays
// under the service lock until it is dispatched. Attachments are preserved.
func (s *Service) MutateQueuedMessage(id, messageID, action, text string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.aborting || s.queueClosing {
		return errors.New("The task has stopped; its pending messages cannot be changed")
	}
	if id == "" || id != s.state.ActiveID || messageID == "" {
		return errors.New("Choose a pending message in the active conversation")
	}
	for index, original := range s.state.QueuedMessages {
		if original.ID != messageID {
			continue
		}
		message := original
		kind := "desk.queue-update"
		switch action {
		case "edit":
			message.Text = strings.TrimSpace(text)
			if message.Text == "" && len(message.Images) == 0 {
				return errors.New("Write a message first")
			}
		case "steer":
			if !s.state.Running {
				return errors.New("Continue the task before steering it")
			}
			message.Mode = QueueSteer
		case "delete":
			kind = "desk.queue-delete"
		default:
			return errors.New("Choose edit, delete or steer")
		}
		persist := func() error { return s.durableQueueLocked(kind, message) }
		if s.queueDispatched[messageID] {
			if s.session == nil {
				return errors.New("The pending message is no longer available")
			}
			mode := "followUp"
			if message.Mode == QueueSteer {
				mode = "steer"
			}
			err := s.session.UpdatePendingMessage(messageID, codingagent.PendingMessageUpdate{
				Text: message.Text, Mode: mode, Options: codingagent.PromptOptions{Images: message.Images},
				Delete: action == "delete", BeforeCommit: persist,
			})
			if err != nil {
				return err
			}
		} else if err := persist(); err != nil {
			return err
		}
		if action == "delete" || message.Mode != original.Mode {
			s.state.QueuedMessages = append(s.state.QueuedMessages[:index], s.state.QueuedMessages[index+1:]...)
			if action == "delete" {
				delete(s.queueDispatched, messageID)
			} else {
				// Promotion appends after existing instructions, including recovery.
				s.state.QueuedMessages = append(s.state.QueuedMessages, message)
			}
		} else {
			s.state.QueuedMessages[index] = message
		}
		s.changedLocked()
		return nil
	}
	return codingagent.ErrPendingMessageNotFound
}

func (s *Service) dispatchMessageLocked(message QueuedMessage) error {
	var err error
	options := codingagent.PromptOptions{Images: message.Images, QueueID: message.ID}
	if message.Mode == QueueSteer {
		err = s.session.Steer(message.Text, options)
	} else {
		err = s.session.FollowUp(message.Text, options)
	}
	if err == nil {
		s.queueDispatched[message.ID] = true
	}
	return err
}

func (s *Service) dispatchQueueLocked() {
	if s.session == nil || !s.queueReady || s.aborting || s.closed || s.queueClosing {
		return
	}
	for _, message := range s.state.QueuedMessages {
		if !s.queueDispatched[message.ID] {
			if err := s.dispatchMessageLocked(message); err != nil {
				s.state.Error = err.Error()
				return
			}
		}
	}
}

func (s *Service) observeQueuedMessageLocked(event codingagent.SessionEvent) {
	if event.Message == nil || event.Message.Message == nil || event.Message.Message.Role != aitypes.UserMessageRole || event.Message.Message.User == nil {
		return
	}
	if !s.queueInitialSeen {
		// The initial prompt is accepted after optional compaction. Dispatching
		// earlier would place messages on the agent that compaction rebuilds.
		s.queueInitialSeen, s.queueReady = true, true
		s.dispatchQueueLocked()
		return
	}
	// Native IDs disambiguate identical input and survive SDK expansion/rebuilds.
	for i, message := range s.state.QueuedMessages {
		if message.ID == event.Message.QueueID && s.queueDispatched[message.ID] {
			if err := s.durableQueueLocked("desk.delivered", message); err != nil {
				s.state.Error = err.Error()
			}
			delete(s.queueDispatched, message.ID)
			s.state.QueuedMessages = append(s.state.QueuedMessages[:i], s.state.QueuedMessages[i+1:]...)
			return
		}
	}
}

func (s *Service) clearQueueLocked() {
	s.state.QueuedMessages = []QueuedMessage{}
	s.queueDispatched = map[string]bool{}
	s.queueReady, s.queueInitialSeen = false, false
}

func (s *Service) permissionAllowsLocked(tool string) bool {
	mode := s.permissionModeLocked()
	return mode.allows(tool) || (mode == PermissionFullAccess && s.externalTools[tool])
}
