package desk

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

const MaxDraftBytes = 256 << 10

// DraftScope also supports an unsent message in a workspace with no conversation.
type DraftScope struct {
	ID          string `json:"id,omitempty"`
	WorkspaceID string `json:"workspaceId,omitempty"`
}

type Draft struct {
	Text     string `json:"text"`
	Revision int64  `json:"revision"`
}

type DraftInput struct {
	DraftScope
	Draft
}

func (s *Service) draftFileLocked(scope DraftScope) (string, error) {
	if err := s.availableLocked(); err != nil {
		return "", err
	}
	name := scope.ID
	if scope.ID != "" {
		if scope.WorkspaceID != "" || s.conversationIndexLocked(scope.ID) < 0 {
			return "", errors.New("Conversation not found")
		}
	} else {
		if _, ok := s.workspaceLocked(scope.WorkspaceID); !ok {
			return "", errors.New("Workspace not found")
		}
		name = "workspace-" + scope.WorkspaceID
	}
	if filepath.Base(name) != name || strings.ContainsAny(name, `/\`) {
		return "", errors.New("Invalid draft identifier")
	}
	return filepath.Join(s.dataDir, "drafts", name+".json"), nil
}

func readDraft(path string) (Draft, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return Draft{}, nil
	}
	if err != nil {
		return Draft{}, err
	}
	var draft Draft
	if err := json.Unmarshal(data, &draft); err != nil {
		return Draft{}, err
	}
	return draft, nil
}

func (s *Service) Draft(scope DraftScope) (Draft, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	path, err := s.draftFileLocked(scope)
	if err != nil {
		return Draft{}, err
	}
	return readDraft(path)
}

func (s *Service) SaveDraft(in DraftInput) (Draft, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	path, err := s.draftFileLocked(in.DraftScope)
	if err != nil {
		return Draft{}, err
	}
	if len(in.Text) > MaxDraftBytes || !utf8.ValidString(in.Text) || in.Revision <= 0 || in.Revision > 9007199254740991 {
		return Draft{}, errors.New("Draft must be valid text under 256 KiB")
	}
	previous, err := readDraft(path)
	if err != nil {
		return Draft{}, err
	}
	// Unload saves can arrive before an older autosave. A cleared draft retains
	// its revision so an older request cannot bring submitted text back.
	if in.Revision <= previous.Revision {
		return previous, nil
	}
	if err := writeJSON(path, in.Draft); err != nil {
		return Draft{}, err
	}
	return in.Draft, nil
}

func (s *Service) cleanupDraftsLocked() error {
	root, err := os.OpenRoot(s.dataDir)
	if err != nil {
		return err
	}
	defer root.Close()
	dir, err := root.Open("drafts")
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer dir.Close()
	entries, err := dir.ReadDir(-1)
	if err != nil {
		return err
	}
	valid := map[string]bool{}
	for _, conversation := range s.state.Conversations {
		valid[conversation.ID+".json"] = true
	}
	for _, workspace := range s.state.Workspaces {
		valid["workspace-"+workspace.ID+".json"] = true
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".json") && !valid[entry.Name()] {
			if err := root.Remove(filepath.Join("drafts", entry.Name())); err != nil {
				return err
			}
		}
	}
	return nil
}
