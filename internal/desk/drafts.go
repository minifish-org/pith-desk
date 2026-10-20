package desk

import (
	"context"
	"errors"
	"path/filepath"
	"strings"

	aitypes "github.com/minifish-org/pith/packages/ai/types"
)

const MaxDraftBytes = 8 << 20

// DraftScope also supports an unsent message in a workspace with no conversation.
type DraftScope struct {
	ID          string `json:"id,omitempty"`
	WorkspaceID string `json:"workspaceId,omitempty"`
}

type Draft struct {
	Text     string       `json:"text"`
	Revision int64        `json:"revision"`
	Images   []DraftImage `json:"images,omitempty"`
}

// Draft attachments remain private to their composer scope, outside snapshots.
type DraftImage struct {
	aitypes.ImageContent
	ID   string `json:"id"`
	Name string `json:"name"`
	Size int    `json:"size"`
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

func (s *Service) draftStore() DraftStore {
	return DraftStore{dataDir: s.dataDir, files: s.files}
}
func (s *Service) Draft(scope DraftScope) (Draft, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	path, err := s.draftFileLocked(scope)
	if err != nil {
		return Draft{}, err
	}
	return s.draftStore().read(path)
}

func (s *Service) SaveDraft(in DraftInput) (Draft, error) {
	return s.SaveDraftContext(context.Background(), in)
}

// Check lease cancellation under the same lock as the write. An admitted
// autosave waiting behind another operation must not outlive its page.
func (s *Service) SaveDraftContext(ctx context.Context, in DraftInput) (Draft, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return Draft{}, err
	}
	path, err := s.draftFileLocked(in.DraftScope)
	if err != nil {
		return Draft{}, err
	}
	return s.draftStore().save(path, in.Draft)
}

func (s *Service) cleanupDraftsLocked() error {
	valid := map[string]bool{}
	for _, conversation := range s.catalog.Conversations {
		valid[conversation.ID+".json"] = true
	}
	for _, workspace := range s.catalog.Workspaces {
		valid["workspace-"+workspace.ID+".json"] = true
	}
	return s.draftStore().prune(valid)
}
