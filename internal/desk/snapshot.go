package desk

import (
	"encoding/json"
	"time"

	aitypes "github.com/minifish-org/pith/packages/ai/types"
)

// SnapshotBuilder projects borrowed owner state into a detached public State.
// It has no state of its own and never holds a Service or modifies an owner.
// The caller must keep the owners locked until build returns.
type SnapshotBuilder struct{}

type snapshotSources struct {
	settings      Settings
	login         *LoginStatus
	workspaces    []Workspace
	conversations []Conversation
	activeID      string
	selected      ConversationState
	runStarted    time.Time
	tasks         map[string]snapshotTask
}

type snapshotTask struct {
	conversationID string
	workspaceID    string
	phase          string
	running        bool
	needsApproval  bool
}

func (SnapshotBuilder) build(source snapshotSources, now time.Time) State {
	out := State{
		Settings: source.settings, Login: source.login,
		Workspaces: source.workspaces, Conversations: source.conversations,
		ActiveID: source.activeID, ConversationState: source.selected,
		Runs: []RunSummary{},
	}
	if !source.runStarted.IsZero() {
		out.Runtime.Timing.ElapsedMs = now.Sub(source.runStarted).Milliseconds()
	}
	// Keep catalog order, and include background tasks independently of selection.
	for _, entry := range source.conversations {
		if task, exists := source.tasks[entry.ID]; exists && task.running {
			out.Runs = append(out.Runs, RunSummary{ConversationID: task.conversationID, WorkspaceID: task.workspaceID, Phase: task.phase, NeedsApproval: task.needsApproval})
		}
	}
	if out.Login != nil {
		login := *out.Login
		login.Options = append([]LoginOption{}, login.Options...)
		out.Login = &login
	}
	out.Settings.ThinkingLevels = append([]string{}, source.settings.ThinkingLevels...)
	out.Workspaces = append([]Workspace{}, source.workspaces...)
	out.Conversations = append([]Conversation{}, source.conversations...)
	out.Messages = append([]Message{}, source.selected.Messages...)
	for i := range out.Messages {
		out.Messages[i].Images = append([]MessageImage(nil), out.Messages[i].Images...)
		out.Messages[i].Command = cloneCommandDetails(out.Messages[i].Command)
	}
	out.QueuedMessages = append([]QueuedMessage{}, source.selected.QueuedMessages...)
	for i := range out.QueuedMessages {
		out.QueuedMessages[i].Images = append([]aitypes.ImageContent(nil), out.QueuedMessages[i].Images...)
	}
	if out.Failure != nil {
		failure := *out.Failure
		out.Failure = &failure
	}
	if out.PendingApproval != nil {
		approval := *out.PendingApproval
		approval.Args = append(json.RawMessage(nil), approval.Args...)
		if approval.Preview != nil {
			preview := *approval.Preview
			approval.Preview = &preview
		}
		approval.fileReview = nil
		out.PendingApproval = &approval
	}
	return out
}
