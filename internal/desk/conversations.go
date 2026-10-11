package desk

import (
	"errors"
	"fmt"
	"strings"

	codingagent "github.com/minifish-org/pith/packages/coding-agent"
)

// Reconcile every cached name, including inactive conversations. The
// session record wins after a catalog write failure; no transcript is rewritten
// or opened merely to create a missing session. Corrupt files remain isolated.
func (s *Service) reconcileSessionTitlesLocked() error {
	var failures []error
	changed := false
	for i := range s.catalog.Conversations {
		conversation := &s.catalog.Conversations[i]
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
			s.catalog.rememberTitle(i, title)
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
	if err := s.conversationIdleLocked(id); err != nil {
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
	workspace, ok := s.workspaceLocked(s.catalog.Conversations[index].WorkspaceID)
	if !ok {
		return errors.New("Workspace not found")
	}
	manager, err := s.sessionAdapter().open(id, workspace.Path)
	if err != nil {
		return err
	}
	defer manager.Close()
	if _, err := manager.AppendSessionInfo(title); err != nil {
		return err
	}
	s.catalog.rememberTitle(index, latestSessionTitle(manager, title))
	s.catalog.touch(index, timestamp())
	s.changedLocked()
	if err := s.persistCatalogLocked(); err != nil {
		return fmt.Errorf("Conversation name was saved, but its index could not be updated: %w", err)
	}
	return nil
}

func (s *Service) ExportConversation(id string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.conversationIdleLocked(id); err != nil {
		return "", err
	}
	index := s.conversationIndexLocked(id)
	if index < 0 {
		return "", errors.New("Conversation not found")
	}
	conversation := s.catalog.Conversations[index]
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
			if len(message.Images) > 0 {
				fmt.Fprintf(&markdown, "_[%d image attachment(s), retained in the local session; not embedded in this Markdown export.]_\n\n", len(message.Images))
			}
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

// Catalog existence is checked by the application; the adapter owns SDK IO.
func (s *Service) readConversationSessionLocked(id string) (*codingagent.SessionManager, error) {
	if s.conversationIndexLocked(id) < 0 {
		return nil, errors.New("Conversation not found")
	}
	return s.sessionAdapter().read(id)
}
