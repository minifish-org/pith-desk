package host

import "github.com/minifish-org/pith-desk/internal/desk"

// TaskStatus summarizes every workspace for the desktop Dock. Unread counts
// conversations, not runs, and uses the same persisted acknowledgement as the UI.
type TaskStatus struct {
	NeedsApproval bool
	Unread        int
}

// SetTaskStatusAction delivers an initial status and ordered, deduplicated
// changes. The action must return promptly without calling Server methods;
// native UI work should be scheduled separately.
func (s *Server) SetTaskStatusAction(action func(TaskStatus)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.taskStatusAction = action
	s.taskStatus = summarizeTasks(s.service.Snapshot())
	if action != nil {
		action(s.taskStatus)
	}
}

func summarizeTasks(state desk.State) TaskStatus {
	var status TaskStatus
	for _, run := range state.Runs {
		status.NeedsApproval = status.NeedsApproval || run.NeedsApproval
	}
	for _, entry := range state.Conversations {
		if entry.Unread && entry.CompletedRunID != "" {
			status.Unread++
		}
	}
	return status
}

// Initial installation and live changes share the broadcaster's lock so a
// delayed snapshot cannot overwrite newer status or acknowledged results.
func (s *Server) updateTaskStatusLocked(state desk.State) {
	status := summarizeTasks(state)
	if status == s.taskStatus {
		return
	}
	s.taskStatus = status
	if s.taskStatusAction != nil {
		s.taskStatusAction(status)
	}
}

func (s *Server) clearTaskStatusAction() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.taskStatusAction != nil && s.taskStatus != (TaskStatus{}) {
		s.taskStatusAction(TaskStatus{})
	}
	s.taskStatusAction = nil
	s.taskStatus = TaskStatus{}
}
