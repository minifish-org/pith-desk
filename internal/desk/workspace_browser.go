package desk

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"unicode"
)

const maxWorkspaceMatches = 200
const maxWorkspaceScan = 10000

// WorkspaceDirectory captures only identity/path, without building a transcript
// snapshot for manual terminal input or holding the lock during process IO.
func (s *Service) WorkspaceDirectory(id string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	workspace, found := s.workspaceLocked(id)
	if s.closed || !found {
		return "", errors.New("Workspace not found")
	}
	return workspace.Path, nil
}

type WorkspaceEntry struct {
	Name      string `json:"name"`
	Path      string `json:"path"` // Workspace-relative, retaining the visible symlink name.
	Directory bool   `json:"directory"`
}

type WorkspaceListing struct {
	Entries   []WorkspaceEntry `json:"entries"`
	Truncated bool             `json:"truncated"`
}

// Capture catalog identity under the service lock; directory IO never blocks
// task events. Actual access retains the same canonical/private and os.Root
// checks as file tools, generated files and conversation downloads.
func (s *Service) workspacePolicy(id, path string) (*filePolicy, error) {
	if path != "" && (!filepath.IsLocal(filepath.FromSlash(path)) || strings.IndexFunc(path, unicode.IsControl) >= 0) {
		return nil, errors.New("Choose a workspace-relative path")
	}
	s.mu.Lock()
	workspace, found := s.workspaceLocked(id)
	closed, private := s.closed, s.dataDir
	s.mu.Unlock()
	if closed || !found {
		return nil, errors.New("Workspace not found")
	}
	return newFilePolicy(workspace.Path, private)
}

func (s *Service) WorkspaceFiles(id, path, query string) (WorkspaceListing, error) {
	result := WorkspaceListing{Entries: []WorkspaceEntry{}}
	policy, err := s.workspacePolicy(id, path)
	if err != nil {
		return result, err
	}
	defer policy.root.Close()
	query = strings.ToLower(strings.TrimSpace(query))
	if len(query) > 256 {
		return result, errors.New("Use a file name of at most 256 bytes")
	}
	if path == "" {
		path = "."
	}
	visited := 0
	var visit func(string) error
	visit = func(directory string) error {
		rel, err := policy.checked(directory)
		if err != nil {
			return err
		}
		dir, err := policy.root.OpenFile(rel, os.O_RDONLY|syscall.O_NONBLOCK, 0)
		if err != nil {
			return err
		}
		defer dir.Close()
		for {
			entries, err := dir.ReadDir(128)
			if err != nil && !errors.Is(err, io.EOF) {
				return err
			}
			for _, entry := range entries {
				if visited >= maxWorkspaceScan {
					result.Truncated = true
					return nil
				}
				visited++
				child := filepath.Join(directory, entry.Name())
				info, err := policy.stat(child)
				if err != nil || (!info.IsDir() && !info.Mode().IsRegular()) {
					continue
				}
				if query == "" || !info.IsDir() && strings.Contains(strings.ToLower(entry.Name()), query) {
					if query != "" && len(result.Entries) == maxWorkspaceMatches {
						result.Truncated = true
						return nil
					}
					result.Entries = append(result.Entries, WorkspaceEntry{Name: entry.Name(), Path: filepath.ToSlash(child), Directory: info.IsDir()})
				}
				// Only an explicit search descends. Do not follow directory links:
				// aliases and cycles remain browsable without recursive repetition.
				if query != "" && info.IsDir() && entry.Type()&os.ModeSymlink == 0 {
					_ = visit(child) // Unreadable subdirectories do not hide other matches.
					if result.Truncated {
						return nil
					}
				}
			}
			if errors.Is(err, io.EOF) {
				return nil
			}
		}
	}
	if err := visit(filepath.FromSlash(path)); err != nil {
		return result, err
	}
	sort.Slice(result.Entries, func(i, j int) bool {
		a, b := result.Entries[i], result.Entries[j]
		if a.Directory != b.Directory {
			return a.Directory
		}
		return a.Path < b.Path
	})
	return result, nil
}

func (s *Service) OpenWorkspaceFile(id, path string) (string, io.ReadCloser, error) {
	if path == "" {
		return "", nil, errors.New("Choose a file inside the workspace")
	}
	policy, err := s.workspacePolicy(id, path)
	if err != nil {
		return "", nil, err
	}
	defer policy.root.Close()
	file, err := policy.openRegular(path)
	return filepath.Base(path), file, err
}

func (s *Service) PreviewWorkspaceFile(id, path string) (ArtifactPreview, error) {
	_, file, err := s.OpenWorkspaceFile(id, path)
	if err != nil {
		return ArtifactPreview{}, err
	}
	defer file.Close()
	return previewFile(file, path)
}

func (s *Service) ResolveWorkspaceFile(id, path string) (string, error) {
	policy, err := s.workspacePolicy(id, path)
	if err != nil {
		return "", err
	}
	defer policy.root.Close()
	canonical, err := policy.CanonicalPath(path)
	if err != nil {
		return "", err
	}
	file, err := policy.openRegular(canonical)
	if err != nil {
		return "", err
	}
	file.Close()
	return canonical, nil
}
