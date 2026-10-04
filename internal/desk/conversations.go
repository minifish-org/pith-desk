package desk

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	codingagent "github.com/minifish-org/pith/packages/coding-agent"
)

// A Pith session_info record is the authority for the display name. The catalog
// is only an index, including for older conversations with no session yet.
func latestSessionTitle(manager *codingagent.SessionManager, fallback string) string {
	if manager != nil {
		entries := manager.Entries()
		for i := len(entries) - 1; i >= 0; i-- {
			if entries[i].Type != "session_info" {
				continue
			}
			var info struct {
				Name string `json:"name"`
			}
			if json.Unmarshal(entries[i].Payload, &info) == nil && strings.TrimSpace(info.Name) != "" {
				return info.Name
			}
		}
	}
	return fallback
}

func ensureSessionTitle(manager *codingagent.SessionManager, fallback string) error {
	if manager == nil || strings.TrimSpace(fallback) == "" {
		return nil
	}
	if latestSessionTitle(manager, "") != "" {
		return nil
	}
	_, err := manager.AppendSessionInfo(fallback)
	return err
}

// Reconcile every cached name, including inactive/archived conversations. The
// session record wins after a catalog write failure; no transcript is rewritten
// or opened merely to create a missing session. Corrupt files remain isolated.
func (s *Service) reconcileSessionTitlesLocked() error {
	var failures []error
	changed := false
	for i := range s.state.Conversations {
		conversation := &s.state.Conversations[i]
		manager, err := s.readConversationSessionLocked(conversation.ID)
		if err != nil {
			failures = append(failures, fmt.Errorf("Read conversation %q: %w", conversation.Title, err))
			continue
		}
		if manager == nil {
			continue
		}
		title := latestSessionTitle(manager, conversation.Title)
		_ = manager.Close()
		if title != conversation.Title {
			conversation.Title = title
			changed = true
		}
	}
	if changed {
		if err := s.persistCatalogLocked(); err != nil {
			failures = append(failures, fmt.Errorf("Update conversation name index: %w", err))
		}
	}
	return errors.Join(failures...)
}

func (s *Service) RenameConversation(id, title string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.idleLocked(); err != nil {
		return err
	}
	index := s.conversationIndexLocked(id)
	if index < 0 {
		return errors.New("Conversation not found")
	}
	title = strings.TrimSpace(strings.NewReplacer("\r", " ", "\n", " ").Replace(title))
	if title == "" {
		return errors.New("Enter a conversation name")
	}
	workspace, ok := s.workspaceLocked(s.state.Conversations[index].WorkspaceID)
	if !ok {
		return errors.New("Workspace not found")
	}
	manager, err := openDeskSession(s.sessionFile(id), id, workspace.Path)
	if err != nil {
		return err
	}
	defer manager.Close()
	if _, err := manager.AppendSessionInfo(title); err != nil {
		return err
	}
	s.state.Conversations[index].Title = latestSessionTitle(manager, title)
	s.state.Conversations[index].UpdatedAt = timestamp()
	s.changedLocked()
	if err := s.persistCatalogLocked(); err != nil {
		return fmt.Errorf("Conversation name was saved, but its index could not be updated: %w", err)
	}
	return nil
}

func (s *Service) ArchiveConversation(id string, archived bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.idleLocked(); err != nil {
		return err
	}
	index := s.conversationIndexLocked(id)
	if index < 0 {
		return errors.New("Conversation not found")
	}
	if s.state.Conversations[index].Archived == archived {
		return nil
	}
	previous := s.state.Conversations[index]
	s.state.Conversations[index].Archived = archived
	s.state.Conversations[index].UpdatedAt = timestamp()
	if err := s.persistCatalogLocked(); err != nil {
		s.state.Conversations[index] = previous
		return err
	}
	s.changedLocked()
	return nil
}

func (s *Service) ExportConversation(id string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.idleLocked(); err != nil {
		return "", err
	}
	index := s.conversationIndexLocked(id)
	if index < 0 {
		return "", errors.New("Conversation not found")
	}
	conversation := s.state.Conversations[index]
	manager, err := s.readConversationSessionLocked(id)
	if err != nil {
		return "", err
	}
	if manager != nil {
		defer manager.Close()
	}
	title := latestSessionTitle(manager, conversation.Title)
	var markdown strings.Builder
	markdown.WriteString("# " + strings.ReplaceAll(title, "\n", " ") + "\n\n")
	if workspace, ok := s.workspaceLocked(conversation.WorkspaceID); ok {
		markdown.WriteString("Workspace: " + workspace.Name + "\n\n")
	}
	if manager != nil {
		for _, message := range messagesFrom(manager) {
			label := "Pith"
			switch message.Role {
			case "user":
				label = "You"
			case "tool":
				label = "Tool: " + message.ToolName
			case "system":
				label = "System"
			}
			markdown.WriteString("## " + label + "\n\n")
			if message.Status == "error" {
				markdown.WriteString("_This response or tool reported an error._\n\n")
			}
			if message.Role == "tool" {
				// A tool can emit fences; use a longer fence so its output remains literal.
				fence := "```"
				for strings.Contains(message.Text, fence) {
					fence += "`"
				}
				markdown.WriteString(fence + "text\n" + message.Text + "\n" + fence + "\n\n")
			} else {
				markdown.WriteString(message.Text + "\n\n")
			}
		}
	}
	return markdown.String(), nil
}

// Reading an older empty conversation must not create a new persisted session.
func (s *Service) readConversationSessionLocked(id string) (*codingagent.SessionManager, error) {
	if s.conversationIndexLocked(id) < 0 {
		return nil, errors.New("Conversation not found")
	}
	info, err := os.Stat(s.sessionFile(id))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("Conversation session is not a regular file")
	}
	if info.Size() == 0 {
		return nil, nil
	}
	return codingagent.OpenSession(s.sessionFile(id))
}

// The pinned SDK has no public Cwd option on OpenSession. Seed only a missing
// or historical zero-byte session with its exported header type, then let Pith
// own all parsing and subsequent records. Existing transcripts stay untouched.
func openDeskSession(file, id, cwd string) (*codingagent.SessionManager, error) {
	info, err := os.Stat(file)
	if err == nil && info.Size() > 0 {
		return codingagent.OpenSession(file)
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err == nil && !info.Mode().IsRegular() {
		return nil, errors.New("Conversation session is not a regular file")
	}
	canonical, err := canonicalDirectory(cwd)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		return nil, err
	}
	version := codingagent.CurrentSessionVersion
	header, err := json.Marshal(codingagent.SessionHeader{Type: "session", Version: &version, ID: id, Timestamp: timestamp(), Cwd: canonical})
	if err != nil {
		return nil, err
	}
	flags := os.O_WRONLY | os.O_CREATE | os.O_EXCL
	if info != nil {
		flags = os.O_WRONLY | os.O_TRUNC
	}
	output, err := os.OpenFile(file, flags, 0600)
	if errors.Is(err, os.ErrExist) {
		return codingagent.OpenSession(file)
	}
	if err != nil {
		return nil, err
	}
	_, writeErr := output.Write(append(header, '\n'))
	if writeErr == nil {
		writeErr = output.Sync()
	}
	closeErr := output.Close()
	if writeErr != nil {
		return nil, writeErr
	}
	if closeErr != nil {
		return nil, closeErr
	}
	return codingagent.OpenSession(file)
}
