package desk

import (
	"errors"
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
	s.state.QueuedMessages = append(s.state.QueuedMessages, message)
	if s.queueReady && s.session != nil {
		if err := s.dispatchMessageLocked(message); err != nil {
			s.state.QueuedMessages = s.state.QueuedMessages[:len(s.state.QueuedMessages)-1]
			return err
		}
	}
	s.changedLocked()
	return nil
}

func (s *Service) dispatchMessageLocked(message QueuedMessage) error {
	var err error
	if message.Mode == QueueSteer {
		err = s.session.Steer(message.Text, codingagent.PromptOptions{Images: message.Images})
	} else {
		err = s.session.FollowUp(message.Text, codingagent.PromptOptions{Images: message.Images})
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
	text := event.Message.Message.User.Content.Text + blockText(event.Message.Message.User.Content.Blocks)
	// Pith prioritizes steering over follow-up. Remove one matching accepted
	// message, retaining identical messages that are still in the queue.
	for _, mode := range []QueueMode{QueueSteer, QueueFollowUp} {
		for i, message := range s.state.QueuedMessages {
			if message.Mode == mode && message.Text == text && sameImages(message.Images, event.Message.Message.User.Content.Blocks) && s.queueDispatched[message.ID] {
				delete(s.queueDispatched, message.ID)
				s.state.QueuedMessages = append(s.state.QueuedMessages[:i], s.state.QueuedMessages[i+1:]...)
				return
			}
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
