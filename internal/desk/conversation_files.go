package desk

import (
	"errors"
	"io"
	"path/filepath"
)

// Local reply links can refer to shell-generated files that are not recorded
// write/edit artifacts. Open through the owning conversation's workspace root,
// retaining the verified handle so later path replacement cannot redirect it.
func (s *Service) OpenConversationFile(id, path string) (string, io.ReadCloser, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.conversationIdleLocked(id); err != nil {
		return "", nil, err
	}
	index := s.conversationIndexLocked(id)
	if index < 0 {
		return "", nil, errors.New("Conversation not found")
	}
	workspace, ok := s.workspaceLocked(s.catalog.Conversations[index].WorkspaceID)
	if !ok {
		return "", nil, errors.New("Workspace not found")
	}
	if path == "" {
		return "", nil, errors.New("Choose a file link inside this conversation's workspace")
	}
	policy, err := newFilePolicy(workspace.Path, s.dataDir)
	if err != nil {
		return "", nil, err
	}
	defer policy.root.Close()
	canonical, err := policy.CanonicalPath(path)
	if err != nil {
		return "", nil, err
	}
	file, err := policy.openRegular(canonical)
	if err != nil {
		return "", nil, err
	}
	return filepath.Base(canonical), file, nil
}
