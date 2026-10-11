package desk

import (
	"context"
	"encoding/json"
	"errors"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
	"strings"
)

func (r *RunExecution) requestApproval(ctx context.Context, call codingagent.ToolCall, policies ...*filePolicy) error {
	s := r.dependencies
	select {
	case r.approvalGate <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() { <-r.approvalGate }()
	s.mu.Lock()
	if *s.closed || r.aborting || ctx.Err() != nil {
		s.mu.Unlock()
		return context.Canceled
	}
	alreadyAllowed := r.permissionAllowsLocked(call.Name)
	s.mu.Unlock()
	if alreadyAllowed {
		return ctx.Err()
	}
	approval := &Approval{ID: newID(), ToolName: call.Name, Args: append(json.RawMessage(nil), call.Arguments...)}
	if (call.Name == "write_file" || call.Name == "edit_file") && len(policies) > 0 {
		approval.Preview, approval.fileReview = fileApprovalPreview(policies[0], call.Name, call.Arguments)
	}
	if call.Name == "run_command" {
		approval.Warning = "This command runs with your computer account's permissions. It can access files and network outside the workspace. There is no OS sandbox."
	} else if strings.HasPrefix(call.Name, "mcp__") {
		approval.Warning = "This enabled MCP tool uses the external server's permissions. It can access or change data outside this workspace."
	}
	decision := make(chan bool, 1)
	s.mu.Lock()
	if *s.closed || r.aborting || ctx.Err() != nil {
		s.mu.Unlock()
		return context.Canceled
	}
	// A previous call may have waited in the gate while the user changed mode.
	// Recheck under the service lock immediately before creating an approval.
	if r.permissionAllowsLocked(call.Name) {
		s.mu.Unlock()
		return ctx.Err()
	}
	r.PendingApproval, r.approval = approval, decision
	r.approvalCtx = ctx
	s.changedLocked()
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		if r.PendingApproval != nil && r.PendingApproval.ID == approval.ID {
			r.PendingApproval, r.approval = nil, nil
			r.approvalCtx = nil
			s.changedLocked()
		}
		s.mu.Unlock()
	}()
	select {
	case allowed := <-decision:
		if !allowed {
			return errors.New("The user declined this action; do not repeat it without a new request")
		}
		return ctx.Err()
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (r *RunExecution) permissionModeLocked() PermissionMode {
	s := r.dependencies
	if index := s.catalog.conversationIndex(r.id); index >= 0 {
		return normalizedPermissionMode(s.catalog.Conversations[index].PermissionMode)
	}
	return PermissionAsk
}

func (r *RunExecution) resolveApprovalLocked(allow bool) {
	r.approval <- allow // Each decision channel is buffered and answered once.
	r.approval = nil    // Prevent a second reply from blocking or changing the decision.
	r.approvalCtx = nil
	r.PendingApproval = nil
}
