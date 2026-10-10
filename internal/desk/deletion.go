package desk

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const deletionFile = "pending-deletions.json"

// DeleteConversation removes the transcript (including inline attachments) and
// run receipt. Workspace files and user-exported documents are never removed.
func (s *Service) DeleteConversation(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.conversationIdleLocked(id); err != nil {
		return err
	}
	if s.conversationIndexLocked(id) < 0 {
		return errors.New("Conversation not found")
	}
	return s.deleteDataLocked("", []string{id})
}

// RemoveWorkspace unlinks a folder and deletes all its conversations. There is
// deliberately no option to leave conversations without their workspace.
func (s *Service) RemoveWorkspace(id string, conversationCount int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.workspaceIdleLocked(id); err != nil {
		return err
	}
	if _, ok := s.workspaceLocked(id); !ok {
		return errors.New("Workspace not found")
	}
	ids := []string{}
	for _, conversation := range s.state.Conversations {
		if conversation.WorkspaceID == id {
			ids = append(ids, conversation.ID)
		}
	}
	if len(ids) != conversationCount {
		return errors.New("Workspace conversations changed. Review the removal again")
	}
	return s.deleteDataLocked(id, ids)
}

func conversationDataFiles(ids []string) ([]string, error) {
	files := []string{}
	for _, id := range ids {
		if id == "" || id == "." || id == ".." || filepath.Base(id) != id || strings.ContainsAny(id, `/\`) {
			return nil, errors.New("Invalid conversation ID for deletion")
		}
		files = append(files, filepath.Join("sessions", id+".jsonl"), filepath.Join("runs", id+".json"), filepath.Join("costs", id+".jsonl"), filepath.Join("durable", id), filepath.Join("drafts", id+".json"))
	}
	return files, nil
}

func checkDeletionFiles(root *os.Root, files []string) error {
	for _, file := range files {
		info, err := root.Lstat(file)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0 && !(filepath.Dir(file) == "durable" && info.IsDir()) {
			return fmt.Errorf("Conversation data is not a regular file: %s", file)
		}
	}
	return nil
}

func (s *Service) deleteDataLocked(workspaceID string, ids []string) error {
	if err := s.cleanupDeletionsLocked(); err != nil {
		return fmt.Errorf("finish previous deletion: %w", err)
	}
	files, err := conversationDataFiles(ids)
	if err != nil {
		return err
	}
	root, err := os.OpenRoot(s.dataDir)
	if err != nil {
		return err
	}
	defer root.Close()
	if err := checkDeletionFiles(root, files); err != nil {
		return err
	}
	removed := make(map[string]bool, len(ids))
	for _, id := range ids {
		removed[id] = true
	}
	next := catalogState{Workspaces: []Workspace{}, Conversations: []Conversation{}, ActiveID: s.state.ActiveID}
	for _, workspace := range s.state.Workspaces {
		if workspace.ID != workspaceID {
			next.Workspaces = append(next.Workspaces, workspace)
		}
	}
	for _, conversation := range s.state.Conversations {
		if !removed[conversation.ID] {
			next.Conversations = append(next.Conversations, conversation)
		}
	}
	if removed[next.ActiveID] {
		next.ActiveID = ""
	}
	// Persist intent before changing the catalog. On restart, only IDs absent
	// from the committed catalog are deleted; an uncommitted request is canceled.
	if err := writeJSON(filepath.Join(s.dataDir, deletionFile), ids); err != nil {
		return err
	}
	if err := writeJSON(filepath.Join(s.dataDir, "catalog.json"), next); err != nil {
		return errors.Join(err, root.Remove(deletionFile))
	}
	activeRemoved := s.state.ActiveID != next.ActiveID
	s.state.Workspaces, s.state.Conversations, s.state.ActiveID = next.Workspaces, next.Conversations, next.ActiveID
	for _, id := range ids {
		delete(s.runtimes, id)
	}
	if activeRemoved {
		s.selectRuntimeLocked(s.newRuntimeLocked(""))
	}
	s.active.Error = ""
	s.changedLocked()
	if err := s.cleanupDeletionsLocked(); err != nil {
		s.active.Error = "Deletion saved, but local data cleanup failed. Restart Pith Desk to retry: " + err.Error()
		return errors.New(s.active.Error)
	}
	return nil
}

func (s *Service) cleanupDeletionsLocked() error {
	if err := s.cleanupDraftsLocked(); err != nil {
		return err
	}
	root, err := os.OpenRoot(s.dataDir)
	if err != nil {
		return err
	}
	defer root.Close()
	data, err := root.ReadFile(deletionFile)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var ids []string
	if err := json.Unmarshal(data, &ids); err != nil {
		return err
	}
	// Validate the entire journal before any file is touched.
	if _, err := conversationDataFiles(ids); err != nil {
		return err
	}
	committed := []string{}
	for _, id := range ids {
		if s.conversationIndexLocked(id) < 0 {
			committed = append(committed, id)
		}
	}
	files, _ := conversationDataFiles(committed)
	if err := checkDeletionFiles(root, files); err != nil {
		return err
	}
	var failures []error
	for _, file := range files {
		if err := root.RemoveAll(file); err != nil && !errors.Is(err, os.ErrNotExist) {
			failures = append(failures, err)
		}
	}
	if err := errors.Join(failures...); err != nil {
		return err // Keep intent until all committed data has been removed.
	}
	return root.Remove(deletionFile)
}
