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
	BaseURL   string `json:"baseUrl"`
	Model     string `json:"model"`
	HasAPIKey bool   `json:"hasApiKey"`
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
	ID          string `json:"id"`
	Title       string `json:"title"`
	WorkspaceID string `json:"workspaceId"`
	UpdatedAt   string `json:"updatedAt"`
}

type Message struct {
	ID       string `json:"id"`
	Role     string `json:"role"`
	Text     string `json:"text"`
	ToolName string `json:"toolName,omitempty"`
	Status   string `json:"status,omitempty"`
}

type Approval struct {
	ID       string          `json:"id"`
	ToolName string          `json:"toolName"`
	Args     json.RawMessage `json:"args"`
	Warning  string          `json:"warning,omitempty"`
}

type State struct {
	Settings        Settings       `json:"settings"`
	Workspaces      []Workspace    `json:"workspaces"`
	Conversations   []Conversation `json:"conversations"`
	ActiveID        string         `json:"activeId"`
	Messages        []Message      `json:"messages"`
	Running         bool           `json:"running"`
	PendingApproval *Approval      `json:"pendingApproval,omitempty"`
	Error           string         `json:"error,omitempty"`
}

type savedConfig struct {
	BaseURL string `json:"baseUrl"`
	Model   string `json:"model"`
	APIKey  string `json:"apiKey,omitempty"`
}

type catalogState struct {
	Workspaces    []Workspace    `json:"workspaces"`
	Conversations []Conversation `json:"conversations"`
	ActiveID      string         `json:"activeId"`
}

type Service struct {
	mu           sync.Mutex
	dataDir      string
	config       savedConfig
	state        State
	closed       bool
	changes      chan struct{}
	runCancel    context.CancelFunc
	runDone      chan struct{}
	session      *codingagent.AgentSession
	approval     chan bool
	approvalGate chan struct{}
	dataLock     *flock.Flock
	closeDone    chan struct{}
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
		dataLock: dataLock, closeDone: make(chan struct{}),
		config: savedConfig{BaseURL: "https://api.deepseek.com/v1", Model: "deepseek-flash"},
		state:  State{Workspaces: []Workspace{}, Conversations: []Conversation{}, Messages: []Message{}}}
	if err := readJSON(filepath.Join(abs, "settings.json"), &s.config); err != nil {
		return nil, fmt.Errorf("load settings: %w", err)
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
	}
	s.state.ActiveID = saved.ActiveID
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
	base := strings.TrimRight(strings.TrimSpace(input.BaseURL), "/")
	u, err := url.Parse(base)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("Enter an HTTP or HTTPS API base URL without credentials, query, or fragment")
	}
	modelID := strings.TrimSpace(input.Model)
	if _, err := resolveModel(modelID, base); err != nil {
		return err
	}
	next := savedConfig{BaseURL: base, Model: modelID, APIKey: s.config.APIKey}
	if input.APIKey != "" {
		next.APIKey = strings.TrimSpace(input.APIKey)
	}
	if input.ClearAPIKey {
		next.APIKey = ""
	}
	if err := writeJSON(filepath.Join(s.dataDir, "settings.json"), next); err != nil {
		return err
	}
	s.config = next
	s.refreshSettingsLocked()
	s.state.Error = ""
	s.changedLocked()
	return nil
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
	conversation := Conversation{ID: newID(), Title: "New conversation", WorkspaceID: workspaceID, UpdatedAt: timestamp()}
	oldActive := s.state.ActiveID
	s.state.Conversations = append(s.state.Conversations, conversation)
	s.state.ActiveID = conversation.ID
	if err := s.persistCatalogLocked(); err != nil {
		s.state.Conversations = s.state.Conversations[:len(s.state.Conversations)-1]
		s.state.ActiveID = oldActive
		return Conversation{}, err
	}
	s.state.Messages = []Message{}
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

func (s *Service) Send(text string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.idleLocked(); err != nil {
		return err
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return errors.New("Write a message first")
	}
	index := s.conversationIndexLocked(s.state.ActiveID)
	if index < 0 {
		return errors.New("Create a conversation first")
	}
	conversation := s.state.Conversations[index]
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
	if conversation.Title == "New conversation" {
		title := []rune(strings.Split(text, "\n")[0])
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
	s.runCancel = cancel
	s.runDone = make(chan struct{})
	s.state.Running = true
	s.state.Error = ""
	s.changedLocked()
	go s.run(ctx, s.runDone, conversation.ID, workspace, s.config, model, text)
	return nil
}

func (s *Service) Abort() {
	s.mu.Lock()
	cancel, session := s.runCancel, s.session
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if session != nil {
		session.Abort()
	}
}

func (s *Service) DecideApproval(id string, allow bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.state.PendingApproval == nil || s.state.PendingApproval.ID != id || s.approval == nil {
		return errors.New("This approval is no longer pending")
	}
	s.approval <- allow
	s.approval = nil // Prevent a second reply from blocking or changing the decision.
	s.state.PendingApproval = nil
	s.changedLocked()
	return nil
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
	cancel, done := s.runCancel, s.runDone
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if done != nil {
		<-done
	}
	// Keep the store locked until the final transcript/catalog write finishes.
	// The OS also releases this advisory lock if the process crashes. Leave the
	// lock file in place so another process cannot lock a different inode.
	_ = s.dataLock.Close()
	close(s.closeDone)
}

func (s *Service) run(ctx context.Context, done chan struct{}, id string, workspace Workspace, config savedConfig, model *aitypes.Model, text string) {
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
			s.state.Messages = messagesFrom(manager)
			_ = manager.Close()
		}
		s.session, s.runCancel = nil, nil
		s.state.Running = false
		s.state.PendingApproval, s.approval = nil, nil
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
	manager, runErr = codingagent.OpenSession(s.sessionFile(id))
	if runErr != nil {
		return
	}
	policy, runErr = newFilePolicy(workspace.Path, s.dataDir)
	if runErr != nil {
		return
	}
	registry, runErr = s.buildTools(policy)
	if runErr != nil {
		return
	}
	var thinking agenttypes.ThinkingLevel = agenttypes.ThinkingOff
	if model.Reasoning {
		thinking = agenttypes.ThinkingHigh
	}
	session, runErr = codingagent.CreateAgentSession(codingagent.SessionOptions{
		Cwd: workspace.Path, Manager: manager, Tools: registry,
		Model: codingagent.ModelOptions{Model: model, ThinkingLevel: thinking,
			APIKey: func(context.Context, string) (string, error) { return config.APIKey, nil }},
		Resources: codingagent.ResourceOptions{Cwd: workspace.Path, SystemPrompt: deskPrompt},
		Policy:    compactionPolicy(model, config.APIKey),
		OnProviderStreamEvent: func(data any, _ *aitypes.Model) error {
			s.appendProviderText(data)
			return ctx.Err()
		},
	})
	if runErr != nil {
		return
	}
	s.mu.Lock()
	s.session = session
	s.mu.Unlock()
	unsubscribe := session.Subscribe(func(event codingagent.SessionEvent) {
		s.observe(event, manager)
	})
	defer unsubscribe()
	_, runErr = session.Prompt(ctx, text)
}

const deskPrompt = `You are Pith Desk, a personal assistant working with the user's selected folder.
Help the user read, organize, edit, and create useful files. Use the available tools to complete tasks.
Use read_file, grep_files, find_files, and list_files to inspect the workspace.
Use write_file for new files and edit_file for existing content. These actions require user approval.
Use run_command only when file tools cannot complete the task. It requires explicit approval and runs with the user's OS permissions, without an OS sandbox.
Do not attempt to read credentials or private application settings. Never claim a file was changed before its tool succeeds.
Explain results concisely and name any files created or changed.`

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
	case codingagent.SessionEventToolExecutionStart:
		s.state.Messages = append(s.state.Messages, Message{ID: "tool-" + event.ToolCallID, Role: "tool", ToolName: event.ToolName, Text: "Running…", Status: "running"})
	case codingagent.SessionEventToolExecutionEnd:
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
		case msg.Assistant != nil:
			out.Text = blockText(msg.Assistant.Content)
			if msg.Assistant.StopReason == aitypes.StopReasonError || msg.Assistant.StopReason == aitypes.StopReasonAborted {
				out.Status = "error"
			}
		case msg.ToolResult != nil:
			out.Role, out.ToolName = "tool", msg.ToolResult.ToolName
			out.Text, out.Status = blockText(msg.ToolResult.Content), "done"
			if msg.ToolResult.IsError {
				out.Status = "error"
			}
		}
		if out.Text != "" || out.Role == "tool" {
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
	path := s.sessionFile(id)
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		s.state.Messages = []Message{}
		return nil
	}
	manager, err := codingagent.OpenSession(path)
	if err != nil {
		return err
	}
	defer manager.Close()
	s.state.Messages = messagesFrom(manager)
	return nil
}

func (s *Service) sessionFile(id string) string {
	return filepath.Join(s.dataDir, "sessions", id+".jsonl")
}

func (s *Service) idleLocked() error {
	if s.closed {
		return errors.New("Pith Desk has closed")
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
	s.state.Settings = Settings{BaseURL: s.config.BaseURL, Model: s.config.Model, HasAPIKey: s.config.APIKey != ""}
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
