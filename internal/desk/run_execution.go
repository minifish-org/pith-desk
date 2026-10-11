package desk

import (
	"context"
	"errors"
	"github.com/minifish-org/pith-desk/internal/workspacefs"
	agenttypes "github.com/minifish-org/pith/packages/agent/types"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
	"github.com/minifish-org/pith/packages/durable"
	"time"
)

// All runtime fields are protected by Service.mu. Callbacks capture this
// instance, never the currently selected conversation or its display state.
type RunExecution struct {
	dependencies executionDependencies
	id           string
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

func (r *RunExecution) run(ctx context.Context, id string, workspace Workspace, config savedConfig, model *aitypes.Model, text string, images []aitypes.ImageContent, compact bool) {
	s := r.dependencies
	var manager *codingagent.SessionManager
	var session *codingagent.AgentSession
	var registry *codingagent.ToolRegistry
	var policy *filePolicy
	var runErr error
	defer func() {
		if session != nil {
			_ = session.Close()
		}
		if registry != nil {
			_ = registry.CloseTools()
		}
		if policy != nil {
			_ = policy.root.Close()
		}
		r.closeMCP()
		s.mu.Lock()
		if manager != nil {
			r.updateRuntimeLocked(manager)
			r.Messages = messagesFrom(manager)
			_ = manager.Close()
		}
		if runErr != nil && !errors.Is(runErr, context.Canceled) && !errors.Is(runErr, codingagent.ErrAgentAborted) {
			r.Failure = classifyFailure(runErr, r.Runtime.Phase)
			r.Runtime.Phase = "error"
		} else if ctx.Err() != nil || errors.Is(runErr, codingagent.ErrAgentAborted) {
			r.Runtime.Phase = "stopped"
			r.Failure = &Failure{Kind: "stopped", Message: "You stopped this task.", Advice: "Completed actions remain in place. Review before continuing.", CanContinue: true}
		} else {
			r.Runtime.Phase = "complete"
		}
		r.Runtime.UpdatedAt = timestamp()
		r.updateTimingLocked()
		r.runStarted = time.Time{}
		if err := s.files.WriteJSON(s.receiptFile(id), runReceipt{Runtime: r.Runtime, Failure: r.Failure}); err != nil {
			r.Error = "Task history was saved, but run status could not be saved: " + err.Error()
		}
		r.session, r.activeManager, r.runCancel = nil, nil, nil
		r.aborting = false
		r.clearQueueLocked()
		r.queueClosing = true
		r.externalTools = map[string]bool{}
		r.PendingApproval, r.approval = nil, nil
		r.approvalCtx = nil
		if runErr != nil && !errors.Is(runErr, context.Canceled) && !errors.Is(runErr, codingagent.ErrAgentAborted) {
			r.Error = redact(runErr.Error(), config.APIKey)
		}
		if index := s.catalog.conversationIndex(id); index >= 0 {
			s.catalog.touch(index, timestamp())
		}
		if err := s.catalog.persist(*s.files); err != nil {
			r.Error = err.Error()
		}
		s.changedLocked()
		s.mu.Unlock()
	}()
	if runErr = ctx.Err(); runErr != nil {
		return
	}
	manager, runErr = (SessionAdapter{dataDir: s.dataDir}).open(id, workspace.Path)
	if runErr != nil {
		return
	}
	s.mu.Lock()
	index := s.catalog.conversationIndex(id)
	if index >= 0 {
		runErr = ensureSessionTitle(manager, s.catalog.Conversations[index].Title)
		if runErr == nil {
			s.catalog.rememberTitle(index, latestSessionTitle(manager, s.catalog.Conversations[index].Title))
		}
	}
	s.mu.Unlock()
	if runErr != nil {
		return
	}
	if runErr = workspacefs.ValidateResources(workspace.Path, s.dataDir, codingagent.ConfigDirName); runErr != nil {
		return
	}
	if err := r.connectMCP(ctx); err != nil && ctx.Err() == nil {
		s.mu.Lock()
		r.Error = err.Error()
		s.changedLocked()
		s.mu.Unlock()
	}
	if runErr = ctx.Err(); runErr != nil {
		return
	}
	policy, runErr = newFilePolicy(workspace.Path, s.dataDir)
	if runErr != nil {
		return
	}
	policy.allowImages = model.SupportsImageInput()
	registry, runErr = r.buildTools(policy)
	if runErr != nil {
		return
	}
	thinking := agenttypes.ThinkingLevel(config.ThinkingLevel)
	s.mu.Lock()
	mode := r.permissionModeLocked()
	s.mu.Unlock()
	stream, streamErr := s.connections.stream(ctx, config)
	if streamErr != nil {
		runErr = streamErr
		return
	}
	s.mu.Lock()
	runID := r.Runtime.RunID
	s.mu.Unlock()
	stream = meterStream(ctx, id, runID, config, stream, func() string {
		s.mu.Lock()
		defer s.mu.Unlock()
		if r.Runtime.Phase == "compacting" {
			return "compaction"
		}
		return "agent"
	}, r.appendAssistantText, s.recordCost)
	session, runErr = codingagent.CreateAgentSession(codingagent.SessionOptions{
		Cwd: workspace.Path, Manager: manager, Tools: registry,
		Model: codingagent.ModelOptions{Model: model, ThinkingLevel: thinking, StreamFn: stream,
			APIKey: func(context.Context, string) (string, error) { return config.APIKey, nil }},
		Resources: codingagent.ResourceOptions{Cwd: workspace.Path, SystemPrompt: deskPrompt(mode)},
		Policy:    r.compactionWithStream(model, config.APIKey, stream),
	})
	if runErr != nil {
		return
	}
	s.mu.Lock()
	r.session, r.activeManager = session, manager
	r.Runtime.Phase = "working"
	r.updateRuntimeLocked(manager)
	s.changedLocked()
	s.mu.Unlock()
	unsubscribe := session.Subscribe(func(event codingagent.SessionEvent) {
		r.observe(event, manager)
	})
	defer unsubscribe()
	if compact {
		runErr = session.Compact(ctx)
	} else {
		_, runErr = session.Prompt(ctx, text, codingagent.PromptOptions{Images: images})
	}
	s.mu.Lock()
	r.queueClosing = true
	s.mu.Unlock()
}

func deskPrompt(mode PermissionMode) string {
	permission := "Ask is selected: write_file, edit_file, and run_command request user approval."
	switch normalizedPermissionMode(mode) {
	case PermissionWorkspaceWrite:
		permission = "Workspace changes is selected: write_file and edit_file are allowed inside the workspace; run_command requests user approval."
	case PermissionFullAccess:
		permission = "Full access is selected: workspace file changes and run_command are allowed without individual approval. Commands have the user's OS account permissions and can access files or networks beyond the workspace."
	}
	return `You are Pith Desk, a personal assistant working with the user's selected folder.
Help the user read, organize, edit, and create useful files. Use the available tools to complete tasks.
Use read_file, grep_files, find_files, and list_files to inspect the workspace.
Skills may refer to a tool named read. In this desktop, use read_file instead: it is the guarded file reader. The unguarded builtin read tool is unavailable.
Use write_file for new files and edit_file for existing content. File tools stay inside the selected workspace in every permission mode.
Use run_command only when file tools cannot complete the task. It runs with the user's OS permissions, without an OS sandbox.
Do not attempt to read credentials or private application settings. Never claim a file was changed before its tool succeeds.
Explain results concisely and name any files created or changed.
Codemode is enabled. Use it when code can efficiently combine independent tool calls or filter structured results. Internal calls use the same permission checks.
Use tool_search to discover MCP tools when needed; discovered tools can be called through codemode.
Enabled MCP tools use names beginning with mcp__. They use the external server's permissions rather than the workspace file boundary. Ask and workspace-write modes require individual approval for every MCP call; full-access also authorizes the enabled MCP tools.
The user can change permissions during a task; tools enforce the current selection. At the start of this task:
` + permission
}

func compactionPolicy(model *aitypes.Model, apiKey string) codingagent.RunPolicy {
	return codingagent.RunPolicy{
		CompactReserveTokens: int(model.MaxTokens), KeepRecentMessages: 16,
		Summarize: func(ctx context.Context, messages []agenttypes.AgentMessage) (string, error) {
			// Summarization constructs fresh request options, so explicitly bind
			// the same credential used by the session without ambient env state.
			stream := func(m *aitypes.Model, transcript *aitypes.TranscriptContext, options *aitypes.SimpleStreamOptions) *aitypes.AssistantMessageEventStream {
				request := aitypes.SimpleStreamOptions{}
				if options != nil {
					request = *options
				}
				request.APIKey = &apiKey
				return providerStream(m, transcript, &request)
			}
			return codingagent.GenerateSummary(ctx, messages, model, codingagent.DefaultCompactionPolicy.ReserveTokens, stream, nil, nil)
		},
	}
}

func (r *RunExecution) observe(event codingagent.SessionEvent, manager *codingagent.SessionManager) {
	s := r.dependencies
	s.mu.Lock()
	defer s.mu.Unlock()
	switch event.Type {
	case codingagent.SessionEventMessageEnd:
		r.Messages = messagesFrom(manager)
		r.updateRuntimeLocked(manager)
		r.Runtime.Phase = "working"
		r.observeQueuedMessageLocked(event)
		if err := s.files.WriteJSON(s.receiptFile(r.id), runReceipt{Runtime: r.Runtime}); err != nil {
			r.Error = "Run status could not be saved: " + err.Error()
		}
	case codingagent.SessionEventAgentEnd:
		r.queueClosing = true
	case codingagent.SessionEventAutoRetryStart:
		r.Runtime.Phase = "retrying"
		r.queueClosing = false
		r.queueReady = true
		// Pith preserves pending queues across retry; dispatch only new messages.
		r.dispatchQueueLocked()
	case codingagent.SessionEventAutoRetryEnd:
		r.Runtime.Phase = "working"
	case codingagent.SessionEventToolExecutionStart:
		r.Runtime.Phase = "tool"
		message := Message{ID: "tool-" + event.ToolCallID, Role: "tool", ToolName: event.ToolName, ToolCallID: event.ToolCallID, Text: "Running…", Status: "running"}
		if event.ToolName == "run_command" {
			message.Command = commandDetailsFromSession(manager, event.ToolCallID)
		}
		r.Messages = append(r.Messages, message)
	case codingagent.SessionEventToolExecutionEnd:
		r.Runtime.Phase = "working"
		if event.IsError {
			r.Runtime.ToolFailures++
		}
		for i := range r.Messages {
			if r.Messages[i].ID == "tool-"+event.ToolCallID {
				r.Messages[i].Status = "done"
				if event.IsError {
					r.Messages[i].Status = "error"
				}
				if event.Message != nil && event.Message.Message != nil && event.Message.Message.ToolResult != nil {
					result := event.Message.Message.ToolResult
					r.Messages[i].Text = blockText(result.Content)
					r.Messages[i].Images = messageImages(result.Content)
					applyCommandResult(r.Messages[i].Command, result.Details)
				}
			}
		}
	default:
		return
	}
	s.changedLocked()
}

// Completion is reported only after harness settlement and all resources close.
// The callback runs with the shared mutex held; Service updates Catalog/display.
func (r *RunExecution) startDurable(journal *deskDurable, settled func(error)) {
	s := r.dependencies
	done := r.runDone
	go func() {
		runErr := journal.harness.Resume()
		if runErr == nil {
			_, runErr = journal.harness.WaitForTask(journal.wait, journal.task)
			if cause := context.Cause(journal.wait); cause != nil {
				runErr = cause
			}
		}
		_ = journal.harness.Close(context.Background())
		s.mu.Lock()
		if r.durable == journal {
			r.durable = nil
		}
		if runErr != nil && !*s.closed && !errors.Is(runErr, context.Canceled) {
			r.Error = "Durable task: " + s.redactMCP(redact(runErr.Error(), s.connections.config.APIKey))
			r.Runtime.Phase = "error"
			r.Failure = classifyFailure(runErr, "settlement")
			r.Runtime.UpdatedAt = timestamp()
			if err := s.files.WriteJSON(s.receiptFile(r.id), runReceipt{Runtime: r.Runtime, Failure: r.Failure}); err != nil {
				r.Error += "; run status could not be saved: " + err.Error()
			}
		}
		// Admission may fail before run's cleanup can freeze the timer.
		if !r.runStarted.IsZero() {
			r.updateTimingLocked()
			r.runStarted = time.Time{}
			if r.aborting || *s.closed || errors.Is(runErr, context.Canceled) {
				r.Runtime.Phase = "stopped"
				r.Failure = &Failure{Kind: "stopped", Message: "You stopped this task.", Advice: "Completed actions remain in place. Review before continuing.", CanContinue: true}
			} else if runErr != nil {
				r.Runtime.Phase = "error"
				r.Failure = classifyFailure(runErr, "starting")
			} else {
				r.Runtime.Phase = "complete"
			}
			r.Runtime.UpdatedAt = timestamp()
			if err := s.files.WriteJSON(s.receiptFile(r.id), runReceipt{Runtime: r.Runtime, Failure: r.Failure}); err != nil {
				r.Error = err.Error()
			}
		}
		r.Running = false
		r.runCancel = nil
		settled(runErr)
		close(done)
		s.changedLocked()
		s.mu.Unlock()
	}()
}

func (r *RunExecution) admitAndStartLocked(workspace Workspace, config savedConfig, model *aitypes.Model, text string, images []aitypes.ImageContent, compact bool, pending []QueuedMessage, settled func(error)) error {
	s := r.dependencies
	previousRuntime, previousFailure := r.Runtime, r.Failure
	previousQueue := r.QueuedMessages
	r.runDone = make(chan struct{})
	r.Running = true
	r.Failure = nil
	r.Runtime.Phase, r.Runtime.Model, r.Runtime.ContextWindow = "starting", model.Id, model.ContextWindow
	r.Runtime.Provider, r.Runtime.ThinkingLevel = config.Provider, config.ThinkingLevel
	r.Runtime.RunID = newID()
	r.runStarted = time.Now()
	r.Runtime.Timing = TaskTiming{StartedAt: r.runStarted.UTC().Format(time.RFC3339Nano)}
	r.Runtime.Cost.RunTotal, r.Runtime.Cost.RunRequests, r.Runtime.Cost.RunUnknownRequests = 0, 0, 0
	r.Runtime.UpdatedAt = timestamp()
	if err := s.files.WriteJSON(s.receiptFile(r.id), runReceipt{Runtime: r.Runtime}); err != nil {
		r.runStarted = time.Time{}
		r.Running = false
		r.Runtime, r.Failure = previousRuntime, previousFailure
		r.runCancel = nil
		close(r.runDone)
		return err
	}
	r.aborting = false
	r.clearQueueLocked()
	r.queueClosing = false
	r.Error = ""
	s.changedLocked()
	journal, err := r.admitDurableWithQueueLocked(r.id, workspace, config, model, durableInput{RunID: r.Runtime.RunID, Text: text, Images: images, Compact: compact}, pending)
	if err != nil {
		r.Running = false
		r.Runtime, r.Failure = previousRuntime, previousFailure
		r.QueuedMessages = previousQueue
		r.runStarted = time.Time{}
		_ = s.files.WriteJSON(s.receiptFile(r.id), runReceipt{Runtime: previousRuntime, Failure: previousFailure})
		close(r.runDone)
		r.runCancel = nil
		return err
	}
	r.QueuedMessages = append(r.QueuedMessages, pending...)
	r.durable = journal
	r.runCancel = func() { _, _ = journal.harness.AbortTask(context.Background(), journal.task) }
	r.startDurable(journal, settled)
	return nil
}

func (r *RunExecution) prepareAbortLocked() (context.CancelFunc, *codingagent.AgentSession) {
	s := r.dependencies
	cancel, session := r.runCancel, r.session
	r.aborting = true
	r.PendingApproval, r.approval, r.approvalCtx = nil, nil, nil
	if err := r.durableQueueLocked("desk.clear-queue", QueuedMessage{}); err != nil {
		r.Error = err.Error()
	}
	r.clearQueueLocked()
	r.queueClosing = true
	s.changedLocked()
	return cancel, session
}
