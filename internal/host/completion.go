package host

import "github.com/minifish-org/pith-desk/internal/desk"

// SetCompletionAction installs the desktop notification handler. The browser
// preview handles its own foreground toasts and needs no native callback.
func (s *Server) SetCompletionAction(action func(desk.Conversation, desk.Workspace)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.completionAction = action
}

func completionBaseline(state desk.State) map[string]string {
	seen := make(map[string]string, len(state.Conversations))
	for _, entry := range state.Conversations {
		seen[entry.ID] = entry.CompletedRunID
	}
	return seen
}

// Only live transitions notify. Persisted unread results survive relaunch
// without replaying old notifications. The map is bounded by the catalog.
func (s *Server) newCompletionsLocked(state desk.State) []desk.Conversation {
	var completed []desk.Conversation
	for _, entry := range state.Conversations {
		if entry.Unread && entry.CompletedRunID != "" && s.completedRuns[entry.ID] != entry.CompletedRunID {
			completed = append(completed, entry)
		}
	}
	s.completedRuns = completionBaseline(state)
	return completed
}
