// Package desk embeds Pith behind a desktop-owned service. The UI only receives
// detached snapshots; closing or refreshing a webview does not cancel a run.
package desk

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gofrs/flock"
	agenttypes "github.com/minifish-org/pith/packages/agent/types"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
)

type Settings struct {
	Provider         string         `json:"provider"`
	ModelName        string         `json:"modelName"`
	ThinkingLevel    string         `json:"thinkingLevel"`
	ThinkingLevels   []string       `json:"thinkingLevels"`
	BaseURL          string         `json:"baseUrl"`
	Model            string         `json:"model"`
	HasConnections   bool           `json:"hasConnections"`
	HasAPIKey        bool           `json:"hasApiKey"`
	Appearance       AppearanceMode `json:"appearance"`
	SupportsImages   bool           `json:"supportsImages"`
	ImageUploadLimit int            `json:"imageUploadLimit"`
}

// An empty APIKey preserves only the same provider/endpoint key.
// ClearAPIKey explicitly removes that provider’s saved key.
type ConfigInput struct {
	Provider      string `json:"provider"`
	ThinkingLevel string `json:"thinkingLevel"`
	BaseURL       string `json:"baseUrl"`
	Model         string `json:"model"`
	APIKey        string `json:"apiKey,omitempty"`
	ClearAPIKey   bool   `json:"clearApiKey,omitempty"`
}

type Workspace struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Path string `json:"path"`
}

type Conversation struct {
	ID             string         `json:"id"`
	Title          string         `json:"title"`
	WorkspaceID    string         `json:"workspaceId"`
	UpdatedAt      string         `json:"updatedAt"`
	PermissionMode PermissionMode `json:"permissionMode"`
	CompletedRunID string         `json:"completedRunId,omitempty"`
	Unread         bool           `json:"unread,omitempty"`
}

type PermissionMode string

const (
	PermissionAsk            PermissionMode = "ask"
	PermissionWorkspaceWrite PermissionMode = "workspace-write"
	PermissionFullAccess     PermissionMode = "full-access"
)

func validPermissionMode(mode PermissionMode) bool {
	return mode == PermissionAsk || mode == PermissionWorkspaceWrite || mode == PermissionFullAccess
}

func normalizedPermissionMode(mode PermissionMode) PermissionMode {
	if !validPermissionMode(mode) {
		return PermissionAsk
	}
	return mode
}

func (mode PermissionMode) allows(tool string) bool {
	if mode == PermissionFullAccess {
		return tool == "write_file" || tool == "edit_file" || tool == "run_command"
	}
	return mode == PermissionWorkspaceWrite && (tool == "write_file" || tool == "edit_file")
}

type Message struct {
	ID           string          `json:"id"`
	Role         string          `json:"role"`
	Text         string          `json:"text"`
	ToolName     string          `json:"toolName,omitempty"`
	ToolCallID   string          `json:"toolCallId,omitempty"`
	Status       string          `json:"status,omitempty"`
	Images       []MessageImage  `json:"images,omitempty"`
	BranchNodeID string          `json:"branchNodeId,omitempty"`
	Command      *CommandDetails `json:"command,omitempty"`
}

type Approval struct {
	ID       string          `json:"id"`
	ToolName string          `json:"toolName"`
	Args     json.RawMessage `json:"args"`
	Warning  string          `json:"warning,omitempty"`
}

type State struct {
	Login         *LoginStatus   `json:"login,omitempty"`
	Settings      Settings       `json:"settings"`
	Workspaces    []Workspace    `json:"workspaces"`
	Conversations []Conversation `json:"conversations"`
	ActiveID      string         `json:"activeId"`
	Runs          []RunSummary   `json:"runs"`
	ConversationState
}

// ConversationState belongs to one conversation, independent of UI selection.
type ConversationState struct {
	Messages        []Message       `json:"messages"`
	QueuedMessages  []QueuedMessage `json:"queuedMessages"`
	Running         bool            `json:"running"`
	PendingApproval *Approval       `json:"pendingApproval,omitempty"`
	Error           string          `json:"error,omitempty"`
	Runtime         RuntimeStatus   `json:"runtime"`
	Failure         *Failure        `json:"failure,omitempty"`
}

type savedConfig struct {
	AuthPath      string                     `json:"-"`
	Provider      string                     `json:"provider"`
	ThinkingLevel string                     `json:"thinkingLevel"`
	Connections   map[string]savedConnection `json:"connections,omitempty"`
	BaseURL       string                     `json:"baseUrl"`
	Model         string                     `json:"model"`
	APIKey        string                     `json:"apiKey,omitempty"`
	Appearance    AppearanceMode             `json:"appearance"`
}

type catalogState struct {
	Workspaces    []Workspace    `json:"workspaces"`
	Conversations []Conversation `json:"conversations"`
	ActiveID      string         `json:"activeId"`
}

type Service struct {
	active           *conversationRuntime
	runtimes         map[string]*conversationRuntime
	loginCancel      context.CancelFunc
	loginDone        chan struct{}
	loginAnswer      chan string
	mu               sync.Mutex
	dataDir          string
	config           savedConfig
	state            State
	closed           bool
	changes          chan struct{}
	dataLock         *flock.Flock
	closeDone        chan struct{}
	mcpGate          chan struct{}
	mcpConfigs       []savedMCP
	mcpRuntime       *codingagent.MCPRuntime
	mcpConnecting    bool
	mcpConnectCancel context.CancelFunc
	probeCancel      context.CancelFunc
	probeDone        chan struct{}
	modelAuthGate    chan struct{}
	mcpTokens        map[string]*mcpTokenProvider
}

func New(dataDir string) (*Service, error) {
	abs, err := filepath.Abs(dataDir)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(abs, 0700); err != nil {
		return nil, err
	}
	abs, err = filepath.EvalSymlinks(abs)
	if err != nil {
		return nil, err
	}
	dataLock := flock.New(filepath.Join(abs, ".desk.lock"), flock.SetPermissions(0600))
	locked, err := dataLock.TryLock()
	if err != nil {
		_ = dataLock.Close()
		return nil, fmt.Errorf("lock application data: %w", err)
	}
	if !locked {
		_ = dataLock.Close()
		return nil, errors.New("Pith Desk is already open using this application data directory")
	}
	ready := false
	defer func() {
		if !ready {
			_ = dataLock.Close()
		}
	}()
	if err := os.Chmod(abs, 0700); err != nil {
		return nil, err
	}
	s := &Service{dataDir: abs, changes: make(chan struct{}, 1), runtimes: map[string]*conversationRuntime{},
		mcpGate: make(chan struct{}, 1), modelAuthGate: make(chan struct{}, 1), mcpTokens: map[string]*mcpTokenProvider{},
		dataLock: dataLock, closeDone: make(chan struct{}),
		config: savedConfig{BaseURL: "https://api.deepseek.com/v1", Model: "deepseek-flash", Appearance: AppearanceSystem},
		state:  State{Workspaces: []Workspace{}, Conversations: []Conversation{}}}
	s.selectRuntimeLocked(s.newRuntimeLocked(""))
	if err := readJSON(filepath.Join(abs, "settings.json"), &s.config); err != nil {
		return nil, fmt.Errorf("load settings: %w", err)
	}
	s.config.AuthPath = filepath.Join(abs, "auth.json")
	s.config.Appearance = normalizedAppearance(s.config.Appearance)
	s.config = normalizedConfig(s.config)
	if err := readJSON(filepath.Join(abs, "mcp.json"), &s.mcpConfigs); err != nil {
		return nil, fmt.Errorf("load MCP settings: %w", err)
	}
	var saved catalogState
	if err := readJSON(filepath.Join(abs, "catalog.json"), &saved); err != nil {
		return nil, fmt.Errorf("load conversations: %w", err)
	}
	if saved.Workspaces != nil {
		s.state.Workspaces = saved.Workspaces
	}
	if saved.Conversations != nil {
		s.state.Conversations = saved.Conversations
		for i := range s.state.Conversations {
			s.state.Conversations[i].PermissionMode = normalizedPermissionMode(s.state.Conversations[i].PermissionMode)
		}
	}
	s.state.ActiveID = saved.ActiveID
	if err := s.cleanupDeletionsLocked(); err != nil {
		return nil, fmt.Errorf("finish deleting local conversation data: %w", err)
	}
	if err := s.reconcileSessionTitlesLocked(); err != nil {
		s.active.Error = err.Error()
	}
	s.refreshSettingsLocked()
	if saved.ActiveID != "" {
		if err := s.loadMessagesLocked(saved.ActiveID); err != nil {
			s.active.Error = err.Error()
		}
	}
	ready = true
	return s, nil
}

// Changes is a coalesced wake-up channel for one host broadcaster. On wake-up,
// call Snapshot and fan the detached state out to every connected UI.
func (s *Service) Changes() <-chan struct{} { return s.changes }

func (s *Service) Snapshot() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.state
	out.ConversationState = *s.active.ConversationState
	if !s.active.runStarted.IsZero() {
		out.Runtime.Timing.ElapsedMs = time.Since(s.active.runStarted).Milliseconds()
	}
	out.Runs = []RunSummary{}
	for _, entry := range s.state.Conversations {
		if r := s.runtimes[entry.ID]; r != nil && r.Running {
			out.Runs = append(out.Runs, RunSummary{ConversationID: r.id, WorkspaceID: r.workspace.ID, Phase: r.Runtime.Phase, NeedsApproval: r.PendingApproval != nil})
		}
	}
	if out.Login != nil {
		login := *out.Login
		login.Options = append([]LoginOption{}, login.Options...)
		out.Login = &login
	}
	out.Settings.ThinkingLevels = append([]string{}, s.state.Settings.ThinkingLevels...)
	out.Workspaces = append([]Workspace{}, s.state.Workspaces...)
	out.Conversations = append([]Conversation{}, s.state.Conversations...)
	out.Messages = append([]Message{}, s.active.Messages...)
	for i := range out.Messages {
		out.Messages[i].Images = append([]MessageImage(nil), out.Messages[i].Images...)
		out.Messages[i].Command = cloneCommandDetails(out.Messages[i].Command)
	}
	out.QueuedMessages = append([]QueuedMessage{}, s.active.QueuedMessages...)
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
		out.PendingApproval = &approval
	}
	return out
}

func (s *Service) Configure(input ConfigInput) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.idleLocked(); err != nil {
		return err
	}
	next, err := validatedConfig(input, s.config)
	if err != nil {
		return err
	}
	return s.saveConfigLocked(next)
}

func (s *Service) saveConfigLocked(next savedConfig) error {
	affectsActive := s.config.Provider != next.Provider || s.config.Model != next.Model || s.config.ThinkingLevel != next.ThinkingLevel || s.config.BaseURL != next.BaseURL || s.config.APIKey != next.APIKey
	if err := writeJSON(filepath.Join(s.dataDir, "settings.json"), next); err != nil {
		return err
	}
	s.config = next
	s.refreshSettingsLocked()
	s.active.Error = ""
	if affectsActive && s.active.Failure != nil && !s.active.Failure.CanContinue {
		previous := *s.active.Failure
		s.active.Failure.CanContinue = true
		s.active.Failure.Advice = "Model settings changed. Test the connection, then review the conversation before continuing."
		if err := writeJSON(s.receiptFile(s.state.ActiveID), runReceipt{Runtime: s.active.Runtime, Failure: s.active.Failure}); err != nil {
			s.active.Failure = &previous
			s.changedLocked()
			return fmt.Errorf("settings saved, but task status could not be updated: %w", err)
		}
	}
	s.changedLocked()
	return nil
}

func (s *Service) AddWorkspace(path string) (Workspace, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.availableLocked(); err != nil {
		return Workspace{}, err
	}
	path, err := canonicalDirectory(path)
	if err != nil {
		return Workspace{}, err
	}
	// Keeping the application store outside a workspace prevents recursive
	// search and instruction discovery from exposing saved credentials.
	if within(path, s.dataDir) || within(s.dataDir, path) {
		return Workspace{}, errors.New("Choose a folder separate from Pith Desk's private application data")
	}
	for _, existing := range s.state.Workspaces {
		if existing.Path == path {
			return existing, nil
		}
	}
	workspace := Workspace{ID: newID(), Name: filepath.Base(path), Path: path}
	s.state.Workspaces = append(s.state.Workspaces, workspace)
	if err := s.persistCatalogLocked(); err != nil {
		s.state.Workspaces = s.state.Workspaces[:len(s.state.Workspaces)-1]
		return Workspace{}, err
	}
	s.changedLocked()
	return workspace, nil
}

func (s *Service) CreateConversation(workspaceID string) (Conversation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.availableLocked(); err != nil {
		return Conversation{}, err
	}
	if _, ok := s.workspaceLocked(workspaceID); !ok {
		return Conversation{}, errors.New("Select a workspace first")
	}
	conversation := Conversation{ID: newID(), Title: "New conversation", WorkspaceID: workspaceID, UpdatedAt: timestamp(), PermissionMode: PermissionAsk}
	oldActive := s.state.ActiveID
	s.state.Conversations = append(s.state.Conversations, conversation)
	s.state.ActiveID = conversation.ID
	if err := s.persistCatalogLocked(); err != nil {
		s.state.Conversations = s.state.Conversations[:len(s.state.Conversations)-1]
		s.state.ActiveID = oldActive
		return Conversation{}, err
	}
	s.selectRuntimeLocked(s.newRuntimeLocked(conversation.ID))
	s.active.Error = ""
	s.changedLocked()
	return conversation, nil
}

func (s *Service) OpenConversation(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.availableLocked(); err != nil {
		return err
	}
	return s.openConversationLocked(id)
}

// openConversationLocked shares navigation with validated notification targets.
// The caller holds s.mu and has checked that the service is available.
func (s *Service) openConversationLocked(id string) error {
	old := s.state.ActiveID
	previous := s.active
	if err := s.loadMessagesLocked(id); err != nil {
		return err
	}
	if err := s.persistCatalogLocked(); err != nil {
		s.selectRuntimeLocked(previous)
		s.state.ActiveID = old
		return err
	}
	s.active.Error = ""
	s.changedLocked()
	return nil
}

func (s *Service) Send(text string, images ...aitypes.ImageContent) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sendLocked(text, images...)
}

func (s *Service) SendConversation(id, text string, images ...aitypes.ImageContent) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if id == "" || id != s.state.ActiveID {
		return errors.New("The conversation changed; review your message before sending")
	}
	return s.sendLocked(text, images...)
}

func (s *Service) sendLocked(text string, images ...aitypes.ImageContent) error {
	return s.startTaskLocked(text, images, false)
}

func (s *Service) startTaskLocked(text string, images []aitypes.ImageContent, compact bool) error {
	if err := s.availableLocked(); err != nil {
		return err
	}
	r := s.active
	text = strings.TrimSpace(text)
	if text == "" && len(images) == 0 && !compact {
		return errors.New("Write a message or attach an image first")
	}
	index := s.conversationIndexLocked(r.id)
	if index < 0 {
		return errors.New("Create a conversation first")
	}
	conversation := s.state.Conversations[index]
	workspace, ok := s.workspaceLocked(conversation.WorkspaceID)
	if !ok {
		return errors.New("The conversation's workspace is missing")
	}
	if err := s.workspaceIdleLocked(workspace.ID); err != nil {
		return err
	}
	r.workspace = workspace
	currentPath, err := canonicalDirectory(workspace.Path)
	if err != nil || currentPath != workspace.Path {
		return errors.New("The workspace has moved or is no longer available; add its current folder again")
	}
	if s.config.APIKey == "" && !s.config.Connections[s.config.Provider].UseOAuth && s.config.Connections[s.config.Provider].API == "" {
		return errors.New("Save a model API key in Settings first")
	}
	model, err := resolveConfiguredModel(s.config)
	if err != nil {
		return err
	}
	images, err = validateImages(images, model)
	if err != nil {
		return err
	}
	if conversation.Title == "New conversation" && !compact {
		title := []rune(strings.Split(text, "\n")[0])
		if len(title) == 0 {
			title = []rune("Image conversation")
		}
		if len(title) > 80 {
			title = append(title[:77], '.', '.', '.')
		}
		s.state.Conversations[index].Title = string(title)
	}
	s.state.Conversations[index].UpdatedAt = timestamp()
	if err := s.persistCatalogLocked(); err != nil {
		s.state.Conversations[index] = conversation
		return err
	}
	previousRuntime, previousFailure := r.Runtime, r.Failure
	r.runDone = make(chan struct{})
	r.Running = true
	r.Failure = nil
	r.Runtime.Phase, r.Runtime.Model, r.Runtime.ContextWindow = "starting", model.Id, model.ContextWindow
	r.Runtime.Provider, r.Runtime.ThinkingLevel = s.config.Provider, s.config.ThinkingLevel
	r.Runtime.RunID = newID()
	r.runStarted = time.Now()
	r.Runtime.Timing = TaskTiming{StartedAt: r.runStarted.UTC().Format(time.RFC3339Nano)}
	r.Runtime.Cost.RunTotal, r.Runtime.Cost.RunRequests, r.Runtime.Cost.RunUnknownRequests = 0, 0, 0
	r.Runtime.UpdatedAt = timestamp()
	if err := writeJSON(s.receiptFile(conversation.ID), runReceipt{Runtime: r.Runtime}); err != nil {
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
	done := r.runDone
	journal, err := r.admitDurableLocked(conversation.ID, workspace, s.config, model, durableInput{RunID: r.Runtime.RunID, Text: text, Images: images, Compact: compact})
	if err != nil {
		r.Running = false
		r.Runtime, r.Failure = previousRuntime, previousFailure
		r.runStarted = time.Time{}
		_ = writeJSON(s.receiptFile(conversation.ID), runReceipt{Runtime: previousRuntime, Failure: previousFailure})
		close(r.runDone)
		r.runCancel = nil
		return err
	}
	r.durable = journal
	r.runCancel = func() { _, _ = journal.harness.AbortTask(context.Background(), journal.task) }
	go func() {
		runErr := journal.harness.Resume()
		if runErr == nil {
			_, runErr = journal.harness.WaitForTask(context.Background(), journal.task)
		}
		_ = journal.harness.Close(context.Background())
		s.mu.Lock()
		if r.durable == journal {
			r.durable = nil
		}
		if runErr != nil && !s.closed {
			r.Error = "Durable task: " + runErr.Error()
		}
		// Admission may fail before run's cleanup can freeze the timer.
		if !r.runStarted.IsZero() {
			r.updateTimingLocked()
			r.runStarted = time.Time{}
			if r.aborting || s.closed || errors.Is(runErr, context.Canceled) {
				r.Runtime.Phase = "stopped"
				r.Failure = &Failure{Kind: "stopped", Message: "You stopped this task.", Advice: "Completed actions remain in place. Review before continuing.", CanContinue: true}
			} else if runErr != nil {
				r.Runtime.Phase = "error"
				r.Failure = classifyFailure(runErr, "starting")
			} else {
				r.Runtime.Phase = "complete"
			}
			r.Runtime.UpdatedAt = timestamp()
			if err := writeJSON(s.receiptFile(conversation.ID), runReceipt{Runtime: r.Runtime, Failure: r.Failure}); err != nil {
				r.Error = err.Error()
			}
		}
		r.Running = false
		r.runCancel = nil
		if !s.closed && runErr == nil && r.Runtime.Phase == "complete" {
			if err := s.completeConversationLocked(r.id, r.Runtime.RunID); err != nil {
				r.Error = "Task completed, but its unread status could not be saved: " + err.Error()
			}
		}
		if s.active != r {
			delete(s.runtimes, r.id)
		}
		close(done)
		s.changedLocked()
		s.mu.Unlock()
	}()
	return nil
}

func (s *Service) Abort() {
	s.mu.Lock()
	id := s.state.ActiveID
	s.mu.Unlock()
	_ = s.AbortConversation(id)
}

// AbortConversation targets the submitted conversation even after UI navigation.
func (s *Service) AbortConversation(id string) error {
	s.mu.Lock()
	r := s.runtimes[id]
	if r == nil || !r.Running {
		s.mu.Unlock()
		return errors.New("This conversation has no running task")
	}
	cancel, session := r.runCancel, r.session
	r.aborting = true
	r.PendingApproval, r.approval, r.approvalCtx = nil, nil, nil
	if err := r.durableQueueLocked("desk.clear-queue", QueuedMessage{}); err != nil {
		r.Error = err.Error()
	}
	r.clearQueueLocked()
	r.queueClosing = true
	s.changedLocked()
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if session != nil {
		session.Abort()
	}
	return nil
}

func (s *Service) DecideApproval(id string, allow bool) error {
	return s.DecideApprovalWithScope(id, allow, false)
}

// SetPermissionMode changes only the active conversation. The saved catalog
// must succeed before a pending action or a future tool call gets the grant.
func (s *Service) SetPermissionMode(id string, mode PermissionMode) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errors.New("Pith Desk has closed")
	}
	if id != s.state.ActiveID || s.conversationIndexLocked(id) < 0 {
		return errors.New("Change permissions for the active conversation only")
	}
	if !validPermissionMode(mode) {
		return errors.New("Choose ask, workspace-write, or full-access permissions")
	}
	if err := s.persistPermissionModeLocked(id, mode); err != nil {
		return err
	}
	r := s.active
	if r.PendingApproval != nil && r.permissionAllowsLocked(r.PendingApproval.ToolName) && r.approval != nil {
		r.resolveApprovalLocked(true)
	}
	s.changedLocked()
	return nil
}

func (s *Service) DecideApprovalWithScope(id string, allow, alwaysAllow bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var r *conversationRuntime
	for _, candidate := range s.runtimes {
		if candidate.PendingApproval != nil && candidate.PendingApproval.ID == id {
			r = candidate
			break
		}
	}
	// Standalone guarded-tool tests also use the blank conversation runtime.
	if r == nil && s.active.PendingApproval != nil && s.active.PendingApproval.ID == id {
		r = s.active
	}
	// Validate before writing any permission. A stale/canceled browser request
	// must never turn into a lasting grant for another pending action.
	if r == nil || s.closed || r.aborting || r.PendingApproval == nil || r.PendingApproval.ID != id || r.approval == nil || (r.approvalCtx != nil && r.approvalCtx.Err() != nil) {
		return errors.New("This approval is no longer pending")
	}
	if alwaysAllow {
		if !allow {
			return errors.New("Approve the action to allow future workspace changes")
		}
		if tool := r.PendingApproval.ToolName; tool != "write_file" && tool != "edit_file" {
			return errors.New("Always allow applies to workspace file changes; use the permission selector for full access")
		}
		if err := s.persistPermissionModeLocked(r.id, PermissionWorkspaceWrite); err != nil {
			return err
		}
	}
	r.resolveApprovalLocked(allow)
	s.changedLocked()
	return nil
}

func (s *Service) persistPermissionModeLocked(id string, mode PermissionMode) error {
	index := s.conversationIndexLocked(id)
	if index < 0 {
		return errors.New("Conversation not found")
	}
	previous := s.state.Conversations[index].PermissionMode
	s.state.Conversations[index].PermissionMode = mode
	if err := s.persistCatalogLocked(); err != nil {
		s.state.Conversations[index].PermissionMode = previous
		return err
	}
	return nil
}

func (r *conversationRuntime) permissionModeLocked() PermissionMode {
	s := r.service
	if index := s.conversationIndexLocked(r.id); index >= 0 {
		return normalizedPermissionMode(s.state.Conversations[index].PermissionMode)
	}
	return PermissionAsk
}

func (r *conversationRuntime) resolveApprovalLocked(allow bool) {
	r.approval <- allow // Each decision channel is buffered and answered once.
	r.approval = nil    // Prevent a second reply from blocking or changing the decision.
	r.approvalCtx = nil
	r.PendingApproval = nil
}

func (s *Service) Close() {
	s.mu.Lock()
	if s.closed {
		done := s.closeDone
		s.mu.Unlock()
		<-done
		return
	}
	s.closed = true
	mcpCancel := s.mcpConnectCancel
	probeCancel, probeDone := s.probeCancel, s.probeDone
	loginCancel, loginDone := s.loginCancel, s.loginDone
	type closingRun struct {
		journal *deskDurable
		done    chan struct{}
	}
	var runs []closingRun
	for _, r := range s.runtimes {
		if r.Running {
			runs = append(runs, closingRun{r.durable, r.runDone})
			r.clearQueueLocked()
			r.queueClosing = true
		}
	}
	s.mu.Unlock()
	if loginCancel != nil {
		loginCancel()
	}
	if probeCancel != nil {
		probeCancel()
	}
	if mcpCancel != nil {
		mcpCancel()
	}
	// Cancel every harness before waiting for any one. Close preserves uncertain
	// tasks for reviewed recovery; explicit Abort instead settles them as stopped.
	var workers sync.WaitGroup
	for _, r := range runs {
		workers.Add(1)
		go func() { defer workers.Done(); _ = r.journal.harness.Close(context.Background()) }()
	}
	workers.Wait()
	for _, r := range runs {
		<-r.done
	}
	if loginDone != nil {
		<-loginDone
	}
	if probeDone != nil {
		<-probeDone
	}
	s.closeMCP()
	_ = s.dataLock.Close()
	close(s.closeDone)
}

func (r *conversationRuntime) run(ctx context.Context, id string, workspace Workspace, config savedConfig, model *aitypes.Model, text string, images []aitypes.ImageContent, compact bool) {
	s := r.service
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
		if err := writeJSON(s.receiptFile(id), runReceipt{Runtime: r.Runtime, Failure: r.Failure}); err != nil {
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
		if index := s.conversationIndexLocked(id); index >= 0 {
			s.state.Conversations[index].UpdatedAt = timestamp()
		}
		if err := s.persistCatalogLocked(); err != nil {
			r.Error = err.Error()
		}
		s.changedLocked()
		s.mu.Unlock()
	}()
	if runErr = ctx.Err(); runErr != nil {
		return
	}
	manager, runErr = openDeskSession(s.sessionFile(id), id, workspace.Path)
	if runErr != nil {
		return
	}
	s.mu.Lock()
	index := s.conversationIndexLocked(id)
	if index >= 0 {
		runErr = ensureSessionTitle(manager, s.state.Conversations[index].Title)
		if runErr == nil {
			s.state.Conversations[index].Title = latestSessionTitle(manager, s.state.Conversations[index].Title)
		}
	}
	s.mu.Unlock()
	if runErr != nil {
		return
	}
	if runErr = validateRuntimeResources(workspace.Path, s.dataDir); runErr != nil {
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
	stream, streamErr := streamForConfigWithAuthGate(ctx, config, s.modelAuthGate)
	if streamErr != nil {
		runErr = streamErr
		return
	}
	s.mu.Lock()
	runID := r.Runtime.RunID
	s.mu.Unlock()
	stream = s.meteredStream(ctx, id, runID, config, stream, func() string {
		s.mu.Lock()
		defer s.mu.Unlock()
		if r.Runtime.Phase == "compacting" {
			return "compaction"
		}
		return "agent"
	})
	session, runErr = codingagent.CreateAgentSession(codingagent.SessionOptions{
		Cwd: workspace.Path, Manager: manager, Tools: registry,
		Model: codingagent.ModelOptions{Model: model, ThinkingLevel: thinking, StreamFn: stream,
			APIKey: func(context.Context, string) (string, error) { return config.APIKey, nil }},
		Resources: codingagent.ResourceOptions{Cwd: workspace.Path, SystemPrompt: deskPrompt(mode)},
		Policy:    r.compactionWithStream(model, config.APIKey, stream),
		OnProviderStreamEvent: func(data any, _ *aitypes.Model) error {
			r.appendProviderText(data)
			return ctx.Err()
		},
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

func (r *conversationRuntime) observe(event codingagent.SessionEvent, manager *codingagent.SessionManager) {
	s := r.service
	s.mu.Lock()
	defer s.mu.Unlock()
	switch event.Type {
	case codingagent.SessionEventMessageEnd:
		r.Messages = messagesFrom(manager)
		r.updateRuntimeLocked(manager)
		r.Runtime.Phase = "working"
		r.observeQueuedMessageLocked(event)
		if err := writeJSON(s.receiptFile(r.id), runReceipt{Runtime: r.Runtime}); err != nil {
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

// SessionEvent.Text also carries reasoning/tool argument deltas. The provider's
// parsed content field lets us stream only actual assistant text into the UI.
func (r *conversationRuntime) appendProviderText(data any) {
	s := r.service
	chunk, ok := data.(map[string]any)
	if !ok {
		return
	}
	choices, ok := chunk["choices"].([]any)
	if !ok || len(choices) == 0 {
		return
	}
	choice, ok := choices[0].(map[string]any)
	if !ok {
		return
	}
	delta, ok := choice["delta"].(map[string]any)
	if !ok {
		return
	}
	content, _ := delta["content"].(string)
	if content == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	last := len(r.Messages) - 1
	if last < 0 || r.Messages[last].Status != "streaming" {
		r.Messages = append(r.Messages, Message{ID: newID(), Role: "assistant", Status: "streaming"})
		last++
	}
	r.Messages[last].Text += content
	s.changedLocked()
}

func messagesFrom(manager *codingagent.SessionManager) []Message {
	messages := []Message{}
	commands := map[string]*CommandDetails{}
	// Context is the complete active branch. BuildContextEntries is the model's
	// compacted view and would hide older messages from the user's history.
	for _, entry := range manager.Context() {
		if entry.Type != "message" {
			continue
		}
		var message agenttypes.AgentMessage
		if json.Unmarshal(entry.Payload, &message) != nil || message.Message == nil {
			continue
		}
		msg := message.Message
		out := Message{ID: entry.ID, Role: msg.Role}
		switch {
		case msg.User != nil:
			out.Text = msg.User.Content.Text + blockText(msg.User.Content.Blocks)
			out.Images = messageImages(msg.User.Content.Blocks)
			out.BranchNodeID = entry.ID
		case msg.Assistant != nil:
			out.Text = blockText(msg.Assistant.Content)
			out.BranchNodeID = entry.ID
			for _, block := range msg.Assistant.Content {
				if block.IsToolCall() {
					out.BranchNodeID = ""
					if command := commandDetailsForCall(block.ToolCall.Name, block.ToolCall.Arguments, manager.GetCwd()); command != nil {
						commands[block.ToolCall.Id] = command
					}
				}
			}
			if msg.Assistant.StopReason == aitypes.StopReasonError || msg.Assistant.StopReason == aitypes.StopReasonAborted {
				out.Status = "error"
			}
		case msg.ToolResult != nil:
			out.Role, out.ToolName = "tool", msg.ToolResult.ToolName
			out.ToolCallID = msg.ToolResult.ToolCallId
			out.Text, out.Status = blockText(msg.ToolResult.Content), "done"
			out.Images = messageImages(msg.ToolResult.Content)
			if out.ToolName == "run_command" {
				out.Command = cloneCommandDetails(commands[out.ToolCallID])
				applyCommandResult(out.Command, msg.ToolResult.Details)
			}
			if msg.ToolResult.IsError {
				out.Status = "error"
			}
		}
		if out.Text != "" || len(out.Images) > 0 || out.Role == "tool" {
			messages = append(messages, out)
		}
	}
	return messages
}

func blockText(blocks []aitypes.ContentBlock) string {
	var text strings.Builder
	for _, block := range blocks {
		if block.Text != nil {
			text.WriteString(block.Text.Text)
		}
	}
	return text.String()
}

func (s *Service) loadMessagesLocked(id string) error {
	if s.conversationIndexLocked(id) < 0 {
		return errors.New("Conversation not found")
	}
	if r := s.runtimes[id]; r != nil && r.Running {
		s.selectRuntimeLocked(r)
		return nil
	}
	manager, err := s.readConversationSessionLocked(id)
	if err != nil {
		return err
	}
	previous := s.runtimes[id]
	r := s.newRuntimeLocked(id)
	if manager != nil {
		defer manager.Close()
		r.Messages = messagesFrom(manager)
	}
	if err := r.loadRuntimeLocked(id); err != nil {
		if previous != nil {
			s.runtimes[id] = previous
		} else {
			delete(s.runtimes, id)
		}
		return err
	}
	if index := s.conversationIndexLocked(id); index >= 0 {
		s.state.Conversations[index].Title = latestSessionTitle(manager, s.state.Conversations[index].Title)
	}
	s.selectRuntimeLocked(r)
	return nil
}

func (s *Service) sessionFile(id string) string {
	return filepath.Join(s.dataDir, "sessions", id+".jsonl")
}

func (s *Service) idleLocked() error {
	if err := s.availableLocked(); err != nil {
		return err
	}
	if s.anyRunningLocked() {
		return errors.New("Stop all running tasks before changing global settings or connections")
	}
	return nil
}

func (s *Service) availableLocked() error {
	if s.closed {
		return errors.New("Pith Desk has closed")
	}
	if s.loginCancel != nil {
		return errors.New("Finish or cancel sign-in first")
	}
	if s.probeCancel != nil {
		return errors.New("Wait for the connection test to finish or cancel it")
	}
	return nil
}

func (s *Service) workspaceLocked(id string) (Workspace, bool) {
	for _, workspace := range s.state.Workspaces {
		if workspace.ID == id {
			return workspace, true
		}
	}
	return Workspace{}, false
}

func (s *Service) conversationIndexLocked(id string) int {
	for i := range s.state.Conversations {
		if s.state.Conversations[i].ID == id {
			return i
		}
	}
	return -1
}

func (s *Service) refreshSettingsLocked() {
	model, _ := resolveConfiguredModel(s.config)
	name := s.config.Model
	if model != nil {
		name = model.Name
	}
	hasConnections := false
	for _, connection := range s.config.Connections {
		hasConnections = hasConnections || connectionReady(connection)
	}
	s.state.Settings = Settings{HasConnections: hasConnections, Provider: s.config.Provider, ModelName: name, ThinkingLevel: s.config.ThinkingLevel, ThinkingLevels: thinkingLevels(model), BaseURL: s.config.BaseURL, Model: s.config.Model, HasAPIKey: connectionReady(s.config.Connections[s.config.Provider]), Appearance: s.config.Appearance, ImageUploadLimit: MaxImageUploadBytes, SupportsImages: model != nil && model.SupportsImageInput()}
}

func (s *Service) persistCatalogLocked() error {
	return writeJSON(filepath.Join(s.dataDir, "catalog.json"), catalogState{
		Workspaces: s.state.Workspaces, Conversations: s.state.Conversations, ActiveID: s.state.ActiveID,
	})
}

func (s *Service) changedLocked() {
	select {
	case s.changes <- struct{}{}:
	default:
	}
}

func canonicalDirectory(path string) (string, error) {
	if strings.TrimSpace(path) == "" {
		return "", errors.New("Choose an existing folder")
	}
	abs, err := filepath.Abs(strings.TrimSpace(path))
	if err != nil {
		return "", err
	}
	abs, err = filepath.EvalSymlinks(abs)
	if err != nil {
		return "", fmt.Errorf("Open folder: %w", err)
	}
	info, err := os.Stat(abs)
	if err != nil || !info.IsDir() {
		return "", errors.New("Choose an existing folder")
	}
	return abs, nil
}

func within(parent, child string) bool {
	rel, err := filepath.Rel(parent, child)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func newID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		panic("generate identifier: " + err.Error())
	}
	return hex.EncodeToString(bytes[:])
}

func timestamp() string { return time.Now().UTC().Format(time.RFC3339Nano) }

func readJSON(path string, target any) error {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	return json.Unmarshal(data, target)
}

func writeJSON(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".save-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err := file.Write(append(data, '\n')); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}

func redact(value, secret string) string {
	if secret != "" {
		return strings.ReplaceAll(value, secret, "[redacted]")
	}
	return value
}
