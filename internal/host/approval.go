package host

import "github.com/minifish-org/pith-desk/internal/desk"

// SetApprovalAction observes whether any workspace task needs approval. The
// initial value is delivered immediately; subsequent values are ordered and
// deduplicated. The action must return promptly without calling Server methods:
// native UI work should be scheduled separately.
func (s *Server) SetApprovalAction(action func(bool)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.approvalAction = action
	s.approvalPending = anyApprovalPending(s.service.Snapshot())
	if action != nil {
		action(s.approvalPending)
	}
}

func anyApprovalPending(state desk.State) bool {
	for _, run := range state.Runs {
		if run.NeedsApproval {
			return true
		}
	}
	return false
}

// updateApprovalLocked shares the broadcaster's lock so initial installation
// and live changes cannot deliver an older value after a newer one.
func (s *Server) updateApprovalLocked(state desk.State) {
	pending := anyApprovalPending(state)
	if pending == s.approvalPending {
		return
	}
	s.approvalPending = pending
	if s.approvalAction != nil {
		s.approvalAction(pending)
	}
}

func (s *Server) clearApprovalAction() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.approvalAction != nil && s.approvalPending {
		s.approvalAction(false)
	}
	s.approvalAction = nil
	s.approvalPending = false
}
