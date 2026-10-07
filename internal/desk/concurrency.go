package desk

import (
	"context"
	"errors"
	"time"

	codingagent "github.com/minifish-org/pith/packages/coding-agent"
	"github.com/minifish-org/pith/packages/durable"
)

// All runtime fields are protected by Service.mu. Callbacks capture this
// instance, never the currently selected conversation or its display state.
type conversationRuntime struct {
	service *Service
	id      string
	*ConversationState
	workspace        Workspace
	durable          *deskDurable
	recoveredInput   *durableInput
	recoveredJournal durable.ConversationID
	runCancel        context.CancelFunc
	runDone          chan struct{}
	runStarted       time.Time
	session          *codingagent.AgentSession
	activeManager    *codingagent.SessionManager
	aborting         bool
	approval         chan bool
	approvalCtx      context.Context
	approvalGate     chan struct{}
	queueReady       bool
	queueClosing     bool
	queueInitialSeen bool
	queueDispatched  map[string]bool
	externalTools    map[string]bool
	mcpRuntime       *codingagent.MCPRuntime
}

type RunSummary struct {
	ConversationID string `json:"conversationId"`
	WorkspaceID    string `json:"workspaceId"`
	Phase          string `json:"phase"`
	NeedsApproval  bool   `json:"needsApproval"`
}

func (s *Service) newRuntimeLocked(id string) *conversationRuntime {
	r := &conversationRuntime{service: s, id: id,
		ConversationState: &ConversationState{Messages: []Message{}, QueuedMessages: []QueuedMessage{}},
		approvalGate:      make(chan struct{}, 1), queueDispatched: map[string]bool{}, externalTools: map[string]bool{}}
	if id != "" {
		s.runtimes[id] = r
	}
	return r
}

func (s *Service) selectRuntimeLocked(r *conversationRuntime) {
	// Idle conversations reload from their canonical transcript. Retain only
	// the selected view and live tasks, rather than caching every opened chat.
	if previous := s.active; previous != nil && previous.id != r.id && !previous.Running {
		delete(s.runtimes, previous.id)
	}
	if r.id != "" {
		s.runtimes[r.id] = r
	}
	s.active = r
	s.state.ActiveID = r.id
}

func (s *Service) anyRunningLocked() bool {
	for _, r := range s.runtimes {
		if r.Running {
			return true
		}
	}
	return false
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
	for _, r := range s.runtimes {
		if r.Running && (within(w.Path, r.workspace.Path) || within(r.workspace.Path, w.Path)) {
			return errors.New("A task is already running in this workspace or an overlapping folder. Open that conversation or wait for it to finish")
		}
	}
	return nil
}

func (s *Service) conversationIdleLocked(id string) error {
	if err := s.availableLocked(); err != nil {
		return err
	}
	if r := s.runtimes[id]; r != nil && r.Running {
		return errors.New("Stop this conversation's task before changing its history")
	}
	return nil
}
