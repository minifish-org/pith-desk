package desk

import (
	"encoding/json"
	"errors"

	agenttypes "github.com/minifish-org/pith/packages/agent/types"
)

type HistoryNode struct {
	ID       string `json:"id"`
	ParentID string `json:"parentId"`
	Role     string `json:"role"`
	Text     string `json:"text"`
	Active   bool   `json:"active"`
}

func (s *Service) History(id string) ([]HistoryNode, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.conversationIdleLocked(id); err != nil {
		return nil, err
	}
	manager, err := s.readConversationSessionLocked(id)
	if err != nil {
		return nil, err
	}
	nodes := []HistoryNode{}
	if manager == nil {
		return nodes, nil
	}
	defer manager.Close()
	active := map[string]bool{}
	for _, entry := range manager.Context() {
		active[entry.ID] = true
	}
	for _, entry := range manager.Entries() {
		if entry.Type != "message" {
			continue
		}
		var message agenttypes.AgentMessage
		if json.Unmarshal(entry.Payload, &message) != nil || message.Message == nil {
			continue
		}
		m := message.Message
		node := HistoryNode{ID: entry.ID, ParentID: entry.ParentID, Role: m.Role, Active: active[entry.ID]}
		if m.User != nil {
			node.Text = m.User.Content.Text + blockText(m.User.Content.Blocks)
		}
		if m.Assistant != nil {
			// Only settled replies are branch targets. A half tool exchange
			// must never become the end of a provider's next transcript.
			hasCall := false
			for _, block := range m.Assistant.Content {
				hasCall = hasCall || block.IsToolCall()
			}
			if hasCall {
				continue
			}
			node.Text = blockText(m.Assistant.Content)
		}
		if m.User != nil || m.Assistant != nil {
			nodes = append(nodes, node)
		}
	}
	return nodes, nil
}

func (s *Service) BranchConversation(id, nodeID string, before bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.conversationIdleLocked(id); err != nil {
		return err
	}
	if id != s.state.ActiveID {
		return errors.New("Open this conversation before selecting a branch")
	}
	manager, err := s.readConversationSessionLocked(id)
	if err != nil {
		return err
	}
	if manager == nil {
		return errors.New("This conversation has no history yet")
	}
	defer manager.Close()
	target := ""
	found := false
	for _, entry := range manager.Entries() {
		if entry.ID != nodeID || entry.Type != "message" {
			continue
		}
		var message agenttypes.AgentMessage
		if json.Unmarshal(entry.Payload, &message) != nil || message.Message == nil {
			break
		}
		m := message.Message
		if before && m.User == nil {
			break
		}
		if m.Assistant != nil {
			for _, block := range m.Assistant.Content {
				if block.IsToolCall() {
					return errors.New("Select a user message or a completed reply")
				}
			}
		}
		if m.User == nil && m.Assistant == nil {
			break
		}
		found = true
		target = entry.ID
		if before {
			target = entry.ParentID
		}
		break
	}
	if !found {
		return errors.New("History node not found")
	}
	if err = manager.Branch(target); err != nil {
		return err
	}
	s.active.Messages = messagesFrom(manager)
	s.active.Failure = nil
	s.active.Runtime.Phase = "ready"
	s.active.updateRuntimeLocked(manager)
	if err := writeJSON(s.receiptFile(id), runReceipt{Runtime: s.active.Runtime}); err != nil {
		return err
	}
	s.changedLocked()
	return nil
}

func (s *Service) CompactConversation(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if id != s.state.ActiveID {
		return errors.New("Open this conversation before compacting")
	}
	return s.startTaskLocked("", nil, true)
}
