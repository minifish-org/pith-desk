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
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gofrs/flock"
	agenttypes "github.com/minifish-org/pith/packages/agent/types"
	"github.com/minifish-org/pith/packages/ai/api"
	"github.com/minifish-org/pith/packages/ai/catalog"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
)

type Settings struct {
	BaseURL          string         `json:"baseUrl"`
	Model            string         `json:"model"`
	HasAPIKey        bool           `json:"hasApiKey"`
	Appearance       AppearanceMode `json:"appearance"`
	SupportsImages   bool           `json:"supportsImages"`
	ImageUploadLimit int            `json:"imageUploadLimit"`
}

// An empty APIKey preserves the saved key. ClearAPIKey explicitly removes it.
type ConfigInput struct {
	BaseURL     string `json:"baseUrl"`
	Model       string `json:"model"`
	APIKey      string `json:"apiKey,omitempty"`
	ClearAPIKey bool   `json:"clearApiKey,omitempty"`
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
	Archived       bool           `json:"archived"`
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
	ID       string         `json:"id"`
	Role     string         `json:"role"`
	Text     string         `json:"text"`
	ToolName string         `json:"toolName,omitempty"`
	Status   string         `json:"status,omitempty"`
	Images   []MessageImage `json:"images,omitempty"`
}

type Approval struct {
	ID       string          `json:"id"`
	ToolName string          `json:"toolName"`
	Args     json.RawMessage `json:"args"`
	Warning  string          `json:"warning,omitempty"`
}

type State struct {
	Settings        Settings        `json:"settings"`
	Workspaces      []Workspace     `json:"workspaces"`
	Conversations   []Conversation  `json:"conversations"`
	ActiveID        string          `json:"activeId"`
	Messages        []Message       `json:"messages"`
	QueuedMessages  []QueuedMessage `json:"queuedMessages"`
	Running         bool            `json:"running"`
	PendingApproval *Approval       `json:"pendingApproval,omitempty"`
	Error           string          `json:"error,omitempty"`
	Runtime         RuntimeStatus   `json:"runtime"`
	Failure         *Failure        `json:"failure,omitempty"`
}

type savedConfig struct {
	BaseURL    string         `json:"baseUrl"`
	Model      string         `json:"model"`
	APIKey     string         `json:"apiKey,omitempty"`
	Appearance AppearanceMode `json:"appearance"`
}

type catalogState struct {
	Workspaces    []Workspace    `json:"workspaces"`
	Conversations []Conversation `json:"conversations"`
	ActiveID      string         `json:"activeId"`
}

type Service struct {
	mu               sync.Mutex
	dataDir          string
	config           savedConfig
	state            State
	closed           bool
	aborting         bool
	changes          chan struct{}
	runCancel        context.CancelFunc
	runDone          chan struct{}
	session          *codingagent.AgentSession
	activeManager    *codingagent.SessionManager
	approval         chan bool
	approvalCtx      context.Context
	approvalGate     chan struct{}
	dataLock         *flock.Flock
	closeDone        chan struct{}
	queueReady       bool
	queueClosing     bool
	queueInitialSeen bool
	queueDispatched  map[string]bool
	externalTools    map[string]bool
	mcpGate          chan struct{}
	mcpConfigs       []savedMCP
	mcpRuntime       *codingagent.MCPRuntime
	mcpConnecting    bool
	mcpConnectCancel context.CancelFunc
	probeCancel      context.CancelFunc
	probeDone        chan struct{}
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
	s := &Service{dataDir: abs, changes: make(chan struct{}, 1), approvalGate: make(chan struct{}, 1),
		mcpGate: make(chan struct{}, 1), queueDispatched: map[string]bool{}, externalTools: map[string]bool{},
		dataLock: dataLock, closeDone: make(chan struct{}),
		config: savedConfig{BaseURL: "https://api.deepseek.com/v1", Model: "deepseek-flash", Appearance: AppearanceSystem},
		state:  State{Workspaces: []Workspace{}, Conversations: []Conversation{}, Messages: []Message{}, QueuedMessages: []QueuedMessage{}}}
	if err := readJSON(filepath.Join(abs, "settings.json"), &s.config); err != nil {
		return nil, fmt.Errorf("load settings: %w", err)
	}
	s.config.Appearance = normalizedAppearance(s.config.Appearance)
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
	if err := s.reconcileSessionTitlesLocked(); err != nil {
		s.state.Error = err.Error()
	}
	s.refreshSettingsLocked()
	if saved.ActiveID != "" {
		if err := s.loadMessagesLocked(saved.ActiveID); err != nil {
			s.state.Error = err.Error()
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
	out.Workspaces = append([]Workspace{}, s.state.Workspaces...)
	out.Conversations = append([]Conversation{}, s.state.Conversations...)
	out.Messages = append([]Message{}, s.state.Messages...)
	for i := range out.Messages {
		out.Messages[i].Images = append([]MessageImage(nil), out.Messages[i].Images...)
	}
	out.QueuedMessages = append([]QueuedMessage{}, s.state.QueuedMessages...)
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
	if err := writeJSON(filepath.Join(s.dataDir, "settings.json"), next); err != nil {
		return err
	}
	s.config = next
	s.refreshSettingsLocked()
	s.state.Error = ""
	if s.state.Failure != nil && !s.state.Failure.CanContinue {
		previous := *s.state.Failure
		s.state.Failure.CanContinue = true
		s.state.Failure.Advice = "Model settings changed. Test the connection, then review the conversation before continuing."
		if err := writeJSON(s.receiptFile(s.state.ActiveID), runReceipt{Runtime: s.state.Runtime, Failure: s.state.Failure}); err != nil {
			s.state.Failure = &previous
			s.changedLocked()
			return fmt.Errorf("settings saved, but task status could not be updated: %w", err)
		}
	}
	s.changedLocked()
	return nil
}

func validatedConfig(input ConfigInput, current savedConfig) (savedConfig, error) {
	base := strings.TrimRight(strings.TrimSpace(input.BaseURL), "/")
	u, err := url.Parse(base)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return savedConfig{}, errors.New("Enter an HTTP or HTTPS API base URL without credentials, query, or fragment")
	}
	modelID := strings.TrimSpace(input.Model)
	if _, err := resolveModel(modelID, base); err != nil {
		return savedConfig{}, err
	}
	next := savedConfig{BaseURL: base, Model: modelID, APIKey: current.APIKey, Appearance: current.Appearance}
	if input.APIKey != "" {
		next.APIKey = strings.TrimSpace(input.APIKey)
	}
	if input.ClearAPIKey {
		next.APIKey = ""
	}
	return next, nil
}

func (s *Service) AddWorkspace(path string) (Workspace, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.idleLocked(); err != nil {
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
	if err := s.idleLocked(); err != nil {
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
	s.state.Messages = []Message{}
	s.state.Runtime, s.state.Failure = RuntimeStatus{}, nil
	s.state.Error = ""
	s.changedLocked()
	return conversation, nil
}

func (s *Service) OpenConversation(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.idleLocked(); err != nil {
		return err
	}
	if err := s.loadMessagesLocked(id); err != nil {
		return err
	}
	old := s.state.ActiveID
	s.state.ActiveID = id
	if err := s.persistCatalogLocked(); err != nil {
		s.state.ActiveID = old
		_ = s.loadMessagesLocked(old)
		return err
	}
	s.state.Error = ""
	s.changedLocked()
	return nil
}

func (s *Service) Send(text string, images ...aitypes.ImageContent) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sendLocked(text, images...)
}

func (s *Service) sendLocked(text string, images ...aitypes.ImageContent) error {
	if err := s.idleLocked(); err != nil {
		return err
	}
	text = strings.TrimSpace(text)
	if text == "" && len(images) == 0 {
		return errors.New("Write a message or attach an image first")
	}
	index := s.conversationIndexLocked(s.state.ActiveID)
	if index < 0 {
		return errors.New("Create a conversation first")
	}
	conversation := s.state.Conversations[index]
	if conversation.Archived {
		return errors.New("Restore this archived conversation before continuing")
	}
	workspace, ok := s.workspaceLocked(conversation.WorkspaceID)
	if !ok {
		return errors.New("The conversation's workspace is missing")
	}
	currentPath, err := canonicalDirectory(workspace.Path)
	if err != nil || currentPath != workspace.Path {
		return errors.New("The workspace has moved or is no longer available; add its current folder again")
	}
	if s.config.APIKey == "" {
		return errors.New("Save a model API key in Settings first")
	}
	model, err := resolveModel(s.config.Model, s.config.BaseURL)
	if err != nil {
		return err
	}
	images, err = validateImages(images, model)
	if err != nil {
		return err
	}
	if conversation.Title == "New conversation" {
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
	ctx, cancel := context.WithCancel(context.Background())
	previousRuntime, previousFailure := s.state.Runtime, s.state.Failure
	s.runCancel = cancel
	s.runDone = make(chan struct{})
	s.state.Running = true
	s.state.Failure = nil
	s.state.Runtime.Phase, s.state.Runtime.Model, s.state.Runtime.ContextWindow = "starting", model.Id, model.ContextWindow
	s.state.Runtime.UpdatedAt = timestamp()
	if err := writeJSON(s.receiptFile(conversation.ID), runReceipt{Runtime: s.state.Runtime}); err != nil {
		s.state.Running = false
		s.state.Runtime, s.state.Failure = previousRuntime, previousFailure
		cancel()
		s.runCancel = nil
		close(s.runDone)
		return err
	}
	s.aborting = false
	s.clearQueueLocked()
	s.queueClosing = false
	s.state.Error = ""
	s.changedLocked()
	go s.run(ctx, s.runDone, conversation.ID, workspace, s.config, model, text, images)
	return nil
}

func (s *Service) Abort() {
	s.mu.Lock()
	cancel, session := s.runCancel, s.session
	if s.state.Running {
		s.aborting = true
		// The SDK propagates cancellation to tool contexts asynchronously.
		// Invalidate the UI action immediately so a reply after Abort cannot
		// create a lasting grant before that propagation completes.
		s.state.PendingApproval, s.approval, s.approvalCtx = nil, nil, nil
		s.clearQueueLocked()
		s.queueClosing = true
		s.changedLocked()
	}
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if session != nil {
		session.Abort()
	}
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
	if s.state.PendingApproval != nil && s.permissionAllowsLocked(s.state.PendingApproval.ToolName) && s.approval != nil {
		s.resolveApprovalLocked(true)
	}
	s.changedLocked()
	return nil
}

func (s *Service) DecideApprovalWithScope(id string, allow, alwaysAllow bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	// Validate before writing any permission. A stale/canceled browser request
	// must never turn into a lasting grant for another pending action.
	if s.closed || s.aborting || s.state.PendingApproval == nil || s.state.PendingApproval.ID != id || s.approval == nil || (s.approvalCtx != nil && s.approvalCtx.Err() != nil) {
		return errors.New("This approval is no longer pending")
	}
	if alwaysAllow {
		if !allow {
			return errors.New("Approve the action to allow future workspace changes")
		}
		if tool := s.state.PendingApproval.ToolName; tool != "write_file" && tool != "edit_file" {
			return errors.New("Always allow applies to workspace file changes; use the permission selector for full access")
		}
		if err := s.persistPermissionModeLocked(s.state.ActiveID, PermissionWorkspaceWrite); err != nil {
			return err
		}
	}
	s.resolveApprovalLocked(allow)
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

func (s *Service) permissionModeLocked() PermissionMode {
	if index := s.conversationIndexLocked(s.state.ActiveID); index >= 0 {
		return normalizedPermissionMode(s.state.Conversations[index].PermissionMode)
	}
	return PermissionAsk
}

func (s *Service) resolveApprovalLocked(allow bool) {
	s.approval <- allow // Each decision channel is buffered and answered once.
	s.approval = nil    // Prevent a second reply from blocking or changing the decision.
	s.approvalCtx = nil
	s.state.PendingApproval = nil
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
	cancel, done, mcpCancel := s.runCancel, s.runDone, s.mcpConnectCancel
	probeCancel, probeDone := s.probeCancel, s.probeDone
	s.clearQueueLocked()
	s.queueClosing = true
	s.mu.Unlock()
	if probeCancel != nil {
		probeCancel()
	}
	if probeDone != nil {
		<-probeDone
	}
	if mcpCancel != nil {
		mcpCancel()
	}
	if cancel != nil {
		cancel()
	}
	if done != nil {
		<-done
	}
	s.closeMCP()
	// Keep the store locked until the final transcript/catalog write finishes.
	// The OS also releases this advisory lock if the process crashes. Leave the
	// lock file in place so another process cannot lock a different inode.
	_ = s.dataLock.Close()
	close(s.closeDone)
}

func (s *Service) run(ctx context.Context, done chan struct{}, id string, workspace Workspace, config savedConfig, model *aitypes.Model, text string, images []aitypes.ImageContent) {
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
		s.mu.Lock()
		if manager != nil {
			s.updateRuntimeLocked(manager)
			s.state.Messages = messagesFrom(manager)
			_ = manager.Close()
		}
		if runErr != nil && !errors.Is(runErr, context.Canceled) && !errors.Is(runErr, codingagent.ErrAgentAborted) {
			s.state.Failure = classifyFailure(runErr, s.state.Runtime.Phase)
			s.state.Runtime.Phase = "error"
		} else if ctx.Err() != nil || errors.Is(runErr, codingagent.ErrAgentAborted) {
			s.state.Runtime.Phase = "stopped"
			s.state.Failure = &Failure{Kind: "stopped", Message: "You stopped this task.", Advice: "Completed actions remain in place. Review before continuing.", CanContinue: true}
		} else {
			s.state.Runtime.Phase = "complete"
		}
		s.state.Runtime.UpdatedAt = timestamp()
		if err := writeJSON(s.receiptFile(id), runReceipt{Runtime: s.state.Runtime, Failure: s.state.Failure}); err != nil {
			s.state.Error = "Task history was saved, but run status could not be saved: " + err.Error()
		}
		s.session, s.activeManager, s.runCancel = nil, nil, nil
		s.state.Running = false
		s.aborting = false
		s.clearQueueLocked()
		s.queueClosing = true
		s.externalTools = map[string]bool{}
		s.state.PendingApproval, s.approval = nil, nil
		s.approvalCtx = nil
		if runErr != nil && !errors.Is(runErr, context.Canceled) && !errors.Is(runErr, codingagent.ErrAgentAborted) {
			s.state.Error = redact(runErr.Error(), config.APIKey)
		}
		if index := s.conversationIndexLocked(id); index >= 0 {
			s.state.Conversations[index].UpdatedAt = timestamp()
		}
		if err := s.persistCatalogLocked(); err != nil {
			s.state.Error = err.Error()
		}
		s.changedLocked()
		s.mu.Unlock()
		close(done)
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
	if err := s.connectMCP(ctx, true); err != nil && ctx.Err() == nil {
		s.mu.Lock()
		s.state.Error = err.Error()
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
	registry, runErr = s.buildTools(policy)
	if runErr != nil {
		return
	}
	var thinking agenttypes.ThinkingLevel = agenttypes.ThinkingOff
	if model.Reasoning {
		thinking = agenttypes.ThinkingHigh
	}
	s.mu.Lock()
	mode := s.permissionModeLocked()
	s.mu.Unlock()
	session, runErr = codingagent.CreateAgentSession(codingagent.SessionOptions{
		Cwd: workspace.Path, Manager: manager, Tools: registry,
		Model: codingagent.ModelOptions{Model: model, ThinkingLevel: thinking,
			APIKey: func(context.Context, string) (string, error) { return config.APIKey, nil }},
		Resources: codingagent.ResourceOptions{Cwd: workspace.Path, SystemPrompt: deskPrompt(mode)},
		Policy:    s.observedCompactionPolicy(model, config.APIKey),
		OnProviderStreamEvent: func(data any, _ *aitypes.Model) error {
			s.appendProviderText(data)
			return ctx.Err()
		},
	})
	if runErr != nil {
		return
	}
	s.mu.Lock()
	s.session, s.activeManager = session, manager
	s.state.Runtime.Phase = "working"
	s.updateRuntimeLocked(manager)
	s.changedLocked()
	s.mu.Unlock()
	unsubscribe := session.Subscribe(func(event codingagent.SessionEvent) {
		s.observe(event, manager)
	})
	defer unsubscribe()
	_, runErr = session.Prompt(ctx, text, codingagent.PromptOptions{Images: images})
	s.mu.Lock()
	s.queueClosing = true
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
				return api.OpenAICompletionsApi().StreamSimple(m, transcript, &request)
			}
			return codingagent.GenerateSummary(ctx, messages, model, codingagent.DefaultCompactionPolicy.ReserveTokens, stream, nil, nil)
		},
	}
}

func (s *Service) observe(event codingagent.SessionEvent, manager *codingagent.SessionManager) {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch event.Type {
	case codingagent.SessionEventMessageEnd:
		s.state.Messages = messagesFrom(manager)
		s.updateRuntimeLocked(manager)
		s.state.Runtime.Phase = "working"
		s.observeQueuedMessageLocked(event)
		if err := writeJSON(s.receiptFile(s.state.ActiveID), runReceipt{Runtime: s.state.Runtime}); err != nil {
			s.state.Error = "Run status could not be saved: " + err.Error()
		}
	case codingagent.SessionEventAgentEnd:
		s.queueClosing = true
	case codingagent.SessionEventAutoRetryStart:
		s.state.Runtime.Phase = "retrying"
		s.queueClosing = false
		s.queueReady = true
		// Pith preserves pending queues across retry; dispatch only new messages.
		s.dispatchQueueLocked()
	case codingagent.SessionEventAutoRetryEnd:
		s.state.Runtime.Phase = "working"
	case codingagent.SessionEventToolExecutionStart:
		s.state.Runtime.Phase = "tool"
		s.state.Messages = append(s.state.Messages, Message{ID: "tool-" + event.ToolCallID, Role: "tool", ToolName: event.ToolName, Text: "Running…", Status: "running"})
	case codingagent.SessionEventToolExecutionEnd:
		s.state.Runtime.Phase = "working"
		if event.IsError {
			s.state.Runtime.ToolFailures++
		}
		for i := range s.state.Messages {
			if s.state.Messages[i].ID == "tool-"+event.ToolCallID {
				s.state.Messages[i].Status = "done"
				if event.IsError {
					s.state.Messages[i].Status = "error"
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
func (s *Service) appendProviderText(data any) {
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
	last := len(s.state.Messages) - 1
	if last < 0 || s.state.Messages[last].Status != "streaming" {
		s.state.Messages = append(s.state.Messages, Message{ID: newID(), Role: "assistant", Status: "streaming"})
		last++
	}
	s.state.Messages[last].Text += content
	s.changedLocked()
}

func messagesFrom(manager *codingagent.SessionManager) []Message {
	messages := []Message{}
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
		case msg.Assistant != nil:
			out.Text = blockText(msg.Assistant.Content)
			if msg.Assistant.StopReason == aitypes.StopReasonError || msg.Assistant.StopReason == aitypes.StopReasonAborted {
				out.Status = "error"
			}
		case msg.ToolResult != nil:
			out.Role, out.ToolName = "tool", msg.ToolResult.ToolName
			out.Text, out.Status = blockText(msg.ToolResult.Content), "done"
			out.Images = messageImages(msg.ToolResult.Content)
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

func resolveModel(id, baseURL string) (*aitypes.Model, error) {
	var selected *aitypes.Model
	if entry, ok := catalog.DEEPSEEK_MODELS[id]; ok {
		copy := entry.Model
		selected = &copy
	} else {
		providers := make([]string, 0, len(catalog.MODELS))
		for provider := range catalog.MODELS {
			providers = append(providers, string(provider))
		}
		sort.Strings(providers)
		for _, provider := range providers {
			models := catalog.MODELS[aitypes.ProviderId(provider)]
			if entry, ok := models[id]; ok && entry.Model.Api == aitypes.ApiOpenAICompletions {
				copy := entry.Model
				selected = &copy
				break
			}
		}
	}
	if selected == nil {
		return nil, fmt.Errorf("Model %q is not in Pith's compatible model catalog; use deepseek-flash or another catalog model", id)
	}
	selected.BaseUrl = baseURL
	return codingagent.ResolveModel(codingagent.ModelOptions{Model: selected})
}

func (s *Service) loadMessagesLocked(id string) error {
	if s.conversationIndexLocked(id) < 0 {
		return errors.New("Conversation not found")
	}
	manager, err := s.readConversationSessionLocked(id)
	if err != nil {
		return err
	}
	if manager == nil {
		s.state.Messages = []Message{}
		return s.loadRuntimeLocked(id)
	}
	defer manager.Close()
	s.state.Messages = messagesFrom(manager)
	if err := s.loadRuntimeLocked(id); err != nil {
		return err
	}
	if index := s.conversationIndexLocked(id); index >= 0 {
		s.state.Conversations[index].Title = latestSessionTitle(manager, s.state.Conversations[index].Title)
	}
	return nil
}

func (s *Service) sessionFile(id string) string {
	return filepath.Join(s.dataDir, "sessions", id+".jsonl")
}

func (s *Service) idleLocked() error {
	if s.closed {
		return errors.New("Pith Desk has closed")
	}
	if s.probeCancel != nil {
		return errors.New("Wait for the connection test to finish or cancel it")
	}
	if s.state.Running {
		return errors.New("Stop the current task before changing the conversation or settings")
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
	model, _ := resolveModel(s.config.Model, s.config.BaseURL)
	s.state.Settings = Settings{BaseURL: s.config.BaseURL, Model: s.config.Model, HasAPIKey: s.config.APIKey != "", Appearance: s.config.Appearance, ImageUploadLimit: MaxImageUploadBytes, SupportsImages: model != nil && model.SupportsImageInput()}
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
