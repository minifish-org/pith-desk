package desk

import (
	"errors"
)

func (s *Service) newRuntimeLocked(id string) *RunExecution {
	r := &RunExecution{dependencies: s.executionDependencies(), id: id,
		ConversationState: &ConversationState{Messages: []Message{}, QueuedMessages: []QueuedMessage{}},
		approvalGate:      make(chan struct{}, 1), queueDispatched: map[string]bool{}, externalTools: map[string]bool{}}
	if id != "" {
		s.tasks.register(r)
	}
	return r
}

func (s *Service) selectRuntimeLocked(r *RunExecution) {
	// Idle conversations reload from their canonical transcript. Retain only
	// the selected view and live tasks, rather than caching every opened chat.
	if previous := s.active; previous != nil && previous.id != r.id && !previous.Running {
		s.tasks.remove(previous.id)
	}
	if r.id != "" {
		s.tasks.register(r)
	}
	s.active = r
	s.catalog.selectConversation(r.id)
}

func (s *Service) anyRunningLocked() bool {
	return s.tasks.anyRunning()
}

// Canonical paths catch aliases and nested workspaces. Disjoint folders have
// independent admission slots; a slot lasts through durable settlement.
func (s *Service) workspaceIdleLocked(id string) error {
	if err := s.availableLocked(); err != nil {
		return err
	}
	w, ok := s.workspaceLocked(id)
	if !ok {
		return errors.New("Workspace not found")
	}
	return s.tasks.workspaceIdle(w)
}

func (s *Service) conversationIdleLocked(id string) error {
	if err := s.availableLocked(); err != nil {
		return err
	}
	return s.tasks.conversationIdle(id)
}
