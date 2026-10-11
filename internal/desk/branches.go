package desk

import (
	"errors"
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
	if manager != nil {
		defer manager.Close()
	}
	return sessionHistory(manager), nil
}

func (s *Service) BranchConversation(id, nodeID string, before bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.conversationIdleLocked(id); err != nil {
		return err
	}
	if id != s.catalog.ActiveID {
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
	if err := branchSession(manager, nodeID, before); err != nil {
		return err
	}
	s.active.Messages = messagesFrom(manager)
	s.active.Failure = nil
	s.active.Runtime.Phase = "ready"
	s.active.updateRuntimeLocked(manager)
	if err := s.files.WriteJSON(s.receiptFile(id), runReceipt{Runtime: s.active.Runtime}); err != nil {
		return err
	}
	s.changedLocked()
	return nil
}

func (s *Service) CompactConversation(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if id != s.catalog.ActiveID {
		return errors.New("Open this conversation before compacting")
	}
	return s.startTaskLocked("", nil, true)
}
