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
	r := s.runtimes[id]
	if id == "" || r == nil {
		return errors.New("Conversation not found")
	}
	if s.closed || !r.Running || r.aborting || r.queueClosing {
		return errors.New("The task has stopped; send a new message instead")
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
	if err := r.durableQueueLocked("desk.queue", message); err != nil {
		return err
	}
	r.QueuedMessages = append(r.QueuedMessages, message)
	if r.queueReady && r.session != nil {
		if err := r.dispatchMessageLocked(message); err != nil {
			if rollbackErr := r.durableQueueLocked("desk.delivered", message); rollbackErr != nil {
				s.changedLocked()
				return fmt.Errorf("Message saved for recovery but not queued: %w; %v", err, rollbackErr)
			}
			r.QueuedMessages = r.QueuedMessages[:len(r.QueuedMessages)-1]
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
	r := s.runtimes[id]
	if id == "" || r == nil {
		return errors.New("Conversation not found")
	}
	if s.closed || r.aborting || r.queueClosing {
		return errors.New("The task has stopped; its pending messages cannot be changed")
	}
	if messageID == "" {
		return errors.New("Choose a pending message in this conversation")
	}
	for index, original := range r.QueuedMessages {
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
			if !r.Running {
				return errors.New("Continue the task before steering it")
			}
			message.Mode = QueueSteer
		case "delete":
			kind = "desk.queue-delete"
		default:
			return errors.New("Choose edit, delete or steer")
		}
		persist := func() error { return r.durableQueueLocked(kind, message) }
		if r.queueDispatched[messageID] {
			if r.session == nil {
				return errors.New("The pending message is no longer available")
			}
			mode := "followUp"
			if message.Mode == QueueSteer {
				mode = "steer"
			}
			err := r.session.UpdatePendingMessage(messageID, codingagent.PendingMessageUpdate{
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
			r.QueuedMessages = append(r.QueuedMessages[:index], r.QueuedMessages[index+1:]...)
			if action == "delete" {
				delete(r.queueDispatched, messageID)
			} else {
				// Promotion appends after existing instructions, including recovery.
				r.QueuedMessages = append(r.QueuedMessages, message)
			}
		} else {
			r.QueuedMessages[index] = message
		}
		s.changedLocked()
		return nil
	}
	return codingagent.ErrPendingMessageNotFound
}

func (r *conversationRuntime) dispatchMessageLocked(message QueuedMessage) error {
	var err error
	options := codingagent.PromptOptions{Images: message.Images, QueueID: message.ID}
	if message.Mode == QueueSteer {
		err = r.session.Steer(message.Text, options)
	} else {
		err = r.session.FollowUp(message.Text, options)
	}
	if err == nil {
		r.queueDispatched[message.ID] = true
	}
	return err
}

func (r *conversationRuntime) dispatchQueueLocked() {
	s := r.service
	if r.session == nil || !r.queueReady || r.aborting || s.closed || r.queueClosing {
		return
	}
	for _, message := range r.QueuedMessages {
		if !r.queueDispatched[message.ID] {
			if err := r.dispatchMessageLocked(message); err != nil {
				r.Error = err.Error()
				return
			}
		}
	}
}

func (r *conversationRuntime) observeQueuedMessageLocked(event codingagent.SessionEvent) {
	if event.Message == nil || event.Message.Message == nil || event.Message.Message.Role != aitypes.UserMessageRole || event.Message.Message.User == nil {
		return
	}
	if !r.queueInitialSeen {
		// The initial prompt is accepted after optional compaction. Dispatching
		// earlier would place messages on the agent that compaction rebuilds.
		r.queueInitialSeen, r.queueReady = true, true
		r.dispatchQueueLocked()
		return
	}
	// Native IDs disambiguate identical input and survive SDK expansion/rebuilds.
	for i, message := range r.QueuedMessages {
		if message.ID == event.Message.QueueID && r.queueDispatched[message.ID] {
			if err := r.durableQueueLocked("desk.delivered", message); err != nil {
				r.Error = err.Error()
			}
			delete(r.queueDispatched, message.ID)
			r.QueuedMessages = append(r.QueuedMessages[:i], r.QueuedMessages[i+1:]...)
			return
		}
	}
}

func (r *conversationRuntime) clearQueueLocked() {
	r.QueuedMessages = []QueuedMessage{}
	r.queueDispatched = map[string]bool{}
	r.queueReady, r.queueInitialSeen = false, false
}

func (r *conversationRuntime) permissionAllowsLocked(tool string) bool {
	mode := r.permissionModeLocked()
	return mode.allows(tool) || (mode == PermissionFullAccess && r.externalTools[tool])
}
