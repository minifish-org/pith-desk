// Package desk embeds Pith behind a desktop-owned service. The UI only receives
// detached snapshots; closing or refreshing a webview does not cancel a run.
package desk

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gofrs/flock"
	"github.com/minifish-org/pith-desk/internal/localstore"
	"github.com/minifish-org/pith-desk/internal/workspacefs"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
)

type Service struct {
	journals    TaskJournal
	connections Connections
	active      *RunExecution
	tasks       TaskSupervisor
	mu          sync.Mutex
	dataDir     string
	files       localstore.Store
	catalog     Catalog
	closed      bool
	restarting  bool
	changes     chan struct{}
	dataLock    *flock.Flock
	closeDone   chan struct{}
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
	s := &Service{dataDir: abs, changes: make(chan struct{}, 1), tasks: newTaskSupervisor(),
		dataLock: dataLock, closeDone: make(chan struct{}),
		catalog: Catalog{path: filepath.Join(abs, "catalog.json"), catalogState: catalogState{Workspaces: []Workspace{}, Conversations: []Conversation{}}}}
	s.connections = newConnections(abs, &s.mu)
	s.journals = TaskJournal{dataDir: abs}
	s.selectRuntimeLocked(s.newRuntimeLocked(""))
	if err := s.connections.restore(s.files); err != nil {
		return nil, err
	}
	saved, err := s.catalog.restore(s.files)
	if err != nil {
		return nil, fmt.Errorf("load conversations: %w", err)
	}

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
	tasks := s.tasks.snapshotTasks()
	return (SnapshotBuilder{}).build(snapshotSources{
		settings: s.connections.Settings, login: s.connections.Login,
		workspaces: s.catalog.Workspaces, conversations: s.catalog.Conversations, activeID: s.catalog.ActiveID,
		selected: *s.active.ConversationState, runStarted: s.active.runStarted, tasks: tasks,
	}, time.Now())
}

func (s *Service) Configure(input ConfigInput) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.idleLocked(); err != nil {
		return err
	}
	next, err := validatedConfig(input, s.connections.config)
	if err != nil {
		return err
	}
	return s.saveConfigLocked(next)
}

func (s *Service) saveConfigLocked(next savedConfig) error {
	affectsActive := s.connections.config.Provider != next.Provider || s.connections.config.Model != next.Model || s.connections.config.ThinkingLevel != next.ThinkingLevel || s.connections.config.BaseURL != next.BaseURL || s.connections.config.APIKey != next.APIKey
	if err := s.files.WriteJSON(filepath.Join(s.dataDir, "settings.json"), next); err != nil {
		return err
	}
	s.connections.commitConfig(next)
	s.active.Error = ""
	if affectsActive && s.active.Failure != nil && !s.active.Failure.CanContinue {
		previous := *s.active.Failure
		s.active.Failure.CanContinue = true
		s.active.Failure.Advice = "Model settings changed. Test the connection, then review the conversation before continuing."
		if err := s.files.WriteJSON(s.receiptFile(s.catalog.ActiveID), runReceipt{Runtime: s.active.Runtime, Failure: s.active.Failure}); err != nil {
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
	path, err := workspacefs.Directory(path)
	if err != nil {
		return Workspace{}, err
	}
	// Keeping the application store outside a workspace prevents recursive
	// search and instruction discovery from exposing saved credentials.
	if workspacefs.Within(path, s.dataDir) || workspacefs.Within(s.dataDir, path) {
		return Workspace{}, errors.New("Choose a folder separate from Pith Desk's private application data")
	}
	for _, existing := range s.catalog.Workspaces {
		if existing.Path == path {
			return existing, nil
		}
	}
	workspace := Workspace{ID: newID(), Name: filepath.Base(path), Path: path}
	if err := s.catalog.addWorkspace(workspace, s.files); err != nil {
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
	if err := s.catalog.createConversation(conversation, s.files); err != nil {
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
	old := s.catalog.ActiveID
	previous := s.active
	if err := s.loadMessagesLocked(id); err != nil {
		return err
	}
	if err := s.persistCatalogLocked(); err != nil {
		s.selectRuntimeLocked(previous)
		s.catalog.selectConversation(old)
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
	if id == "" || id != s.catalog.ActiveID {
		return errors.New("The conversation changed; review your message before sending")
	}
	return s.sendLocked(text, images...)
}

func (s *Service) sendLocked(text string, images ...aitypes.ImageContent) error {
	return s.startTaskLocked(text, images, false)
}

func (s *Service) startTaskLocked(text string, images []aitypes.ImageContent, compact bool) error {
	return s.startTaskWithQueueLocked(text, images, compact, nil)
}

func (s *Service) startTaskWithQueueLocked(text string, images []aitypes.ImageContent, compact bool, pending []QueuedMessage) error {
	return s.startTaskInputLocked(text, images, compact, pending, "")
}

func (s *Service) startTaskInputLocked(text string, images []aitypes.ImageContent, compact bool, pending []QueuedMessage, editMessageID string) error {
	if s.restarting {
		return errors.New("Pith Desk is updating; try again after restart")
	}
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
	conversation := s.catalog.Conversations[index]
	workspace, ok := s.workspaceLocked(conversation.WorkspaceID)
	if !ok {
		return errors.New("The conversation's workspace is missing")
	}
	if err := s.workspaceIdleLocked(workspace.ID); err != nil {
		return err
	}
	r.workspace = workspace
	currentPath, err := workspacefs.Directory(workspace.Path)
	if err != nil || currentPath != workspace.Path {
		return errors.New("The workspace has moved or is no longer available; add its current folder again")
	}
	if s.connections.config.APIKey == "" && !s.connections.config.Connections[s.connections.config.Provider].UseOAuth && s.connections.config.Connections[s.connections.config.Provider].API == "" {
		return errors.New("Save a model API key in Settings first")
	}
	model, err := resolveConfiguredModel(s.connections.config)
	if err != nil {
		return err
	}
	images, err = validateImages(images, model)
	if err != nil {
		return err
	}
	next := conversation
	if conversation.Title == "New conversation" && !compact {
		title := []rune(strings.Split(text, "\n")[0])
		if len(title) == 0 {
			title = []rune("Image conversation")
		}
		if len(title) > 80 {
			title = append(title[:77], '.', '.', '.')
		}
		next.Title = string(title)
	}
	next.UpdatedAt = timestamp()
	if err := s.catalog.update(index, next, s.files); err != nil {
		return err
	}
	return r.admitAndStartLocked(workspace, s.connections.taskConfig(), model, text, images, compact, pending, editMessageID, func(runErr error) {
		if !s.closed && runErr == nil && r.Runtime.Phase == "complete" {
			if err := s.completeConversationLocked(r.id, r.Runtime.RunID); err != nil {
				r.Error = "Task completed, but its unread status could not be saved: " + err.Error()
			}
		}
		if s.active != r {
			s.tasks.remove(r.id)
		}
	})
}

func (s *Service) Abort() {
	s.mu.Lock()
	id := s.catalog.ActiveID
	s.mu.Unlock()
	_ = s.AbortConversation(id)
}

// AbortConversation targets the submitted conversation even after UI navigation.
func (s *Service) AbortConversation(id string) error {
	s.mu.Lock()
	r := s.tasks.lookup(id)
	if r == nil || !r.Running {
		s.mu.Unlock()
		return errors.New("This conversation has no running task")
	}
	cancel, session := r.prepareAbortLocked()
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
	if id != s.catalog.ActiveID || s.conversationIndexLocked(id) < 0 {
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
	r := s.tasks.pendingApproval(id)
	// Standalone guarded-tool tests also use the blank conversation runtime.
	if r == nil && s.active.PendingApproval != nil && s.active.PendingApproval.ID == id {
		r = s.active
	}
	// Validate before writing any permission. A stale/canceled browser request
	// must never turn into a lasting grant for another pending action.
	if r == nil || s.closed || r.aborting || r.PendingApproval == nil || r.PendingApproval.ID != id || r.approval == nil || (r.approvalCtx != nil && r.approvalCtx.Err() != nil) {
		return errors.New("This approval is no longer pending")
	}
	if allow && r.PendingApproval.fileReview != nil && !r.PendingApproval.fileReview.unchanged() {
		approval := r.PendingApproval
		approval.Preview, approval.fileReview = fileApprovalPreview(approval.fileReview.policy, approval.ToolName, approval.Args)
		approval.ID = newID()
		s.changedLocked()
		return errors.New("The file changed. Review the updated preview before approving")
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
	return s.catalog.setPermission(id, mode, s.files)
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
	mcpCancel := s.connections.mcpConnectCancel
	probeCancel, probeDone := s.connections.probeCancel, s.connections.probeDone
	loginCancel, loginDone := s.connections.loginCancel, s.connections.loginDone
	runs := s.tasks.prepareClose()
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
	closeTasks(runs)
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

func (s *Service) loadMessagesLocked(id string) error {
	if s.conversationIndexLocked(id) < 0 {
		return errors.New("Conversation not found")
	}
	if r := s.tasks.lookup(id); r != nil && r.Running {
		s.selectRuntimeLocked(r)
		return nil
	}
	manager, err := s.readConversationSessionLocked(id)
	if err != nil {
		return err
	}
	previous := s.tasks.lookup(id)
	r := s.newRuntimeLocked(id)
	if manager != nil {
		defer manager.Close()
		r.Messages = messagesFrom(manager)
	}
	if err := r.loadRuntimeLocked(id); err != nil {
		if previous != nil {
			s.tasks.register(previous)
		} else {
			s.tasks.remove(id)
		}
		return err
	}
	if index := s.conversationIndexLocked(id); index >= 0 {
		s.catalog.rememberTitle(index, latestSessionTitle(manager, s.catalog.Conversations[index].Title))
	}
	s.selectRuntimeLocked(r)
	return nil
}

func (s *Service) sessionFile(id string) string {
	return s.sessionAdapter().file(id)
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
	if s.connections.loginCancel != nil {
		return errors.New("Finish or cancel sign-in first")
	}
	if s.connections.probeCancel != nil {
		return errors.New("Wait for the connection test to finish or cancel it")
	}
	return nil
}

func (s *Service) workspaceLocked(id string) (Workspace, bool) { return s.catalog.workspace(id) }

func (s *Service) conversationIndexLocked(id string) int { return s.catalog.conversationIndex(id) }

func (s *Service) refreshSettingsLocked() { s.connections.refreshSettings() }

func (s *Service) persistCatalogLocked() error { return s.catalog.persist(s.files) }

func (s *Service) changedLocked() {
	select {
	case s.changes <- struct{}{}:
	default:
	}
}

func newID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		panic("generate identifier: " + err.Error())
	}
	return hex.EncodeToString(bytes[:])
}

func timestamp() string { return time.Now().UTC().Format(time.RFC3339Nano) }

func redact(value, secret string) string {
	if secret != "" {
		return strings.ReplaceAll(value, secret, "[redacted]")
	}
	return value
}
