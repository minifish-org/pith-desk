package desk

import (
	"errors"
	"net/url"
	"path/filepath"
	"strings"
	"unicode"
)

// WorkspaceFileReferences returns editable paths only. It does not import files
// or read their contents; later file tools still apply the workspace policy.
func (s *Service) WorkspaceFileReferences(workspaceID string, paths []string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	workspace, found := s.workspaceLocked(workspaceID)
	if s.closed || !found {
		return nil, errors.New("Choose a workspace before dropping files")
	}
	if len(paths) == 0 || len(paths) > 100 {
		return nil, errors.New("Drop between 1 and 100 workspace files")
	}
	policy, err := newFilePolicy(workspace.Path, s.dataDir)
	if err != nil {
		return nil, err
	}
	defer policy.root.Close()
	refs := make([]string, 0, len(paths))
	seen := map[string]bool{}
	for _, raw := range paths {
		path, err := droppedFilePath(raw)
		if err != nil {
			return nil, err
		}
		canonical, err := policy.CanonicalPath(path)
		if err != nil {
			return nil, err
		}
		info, err := policy.stat(canonical)
		if err != nil || !info.Mode().IsRegular() {
			return nil, errors.New("Drop existing regular files inside the selected workspace")
		}
		rel, err := filepath.Rel(policy.path, canonical)
		if err != nil {
			return nil, err
		}
		if !seen[rel] {
			seen[rel] = true
			refs = append(refs, filepath.ToSlash(rel))
		}
	}
	return refs, nil
}

// Browsers must supply a complete local file URI, never just File.name. Native
// drops supply absolute OS paths. The workspace policy validates both forms.
func droppedFilePath(raw string) (string, error) {
	path := raw
	if strings.HasPrefix(strings.ToLower(raw), "file:") {
		u, err := url.Parse(raw)
		if err != nil || !strings.EqualFold(u.Scheme, "file") || u.Opaque != "" || u.User != nil || (u.Host != "" && !strings.EqualFold(u.Host, "localhost")) || u.RawQuery != "" || u.Fragment != "" {
			return "", errors.New("Drop a local file from the selected workspace")
		}
		path = filepath.FromSlash(u.Path)
		// Windows file URIs use /C:/... while the native path is C:\\...
		if filepath.Separator == '\\' && len(path) > 3 && path[0] == '\\' && path[2] == ':' {
			path = path[1:]
		}
	}
	if !filepath.IsAbs(path) || strings.IndexFunc(path, unicode.IsControl) >= 0 {
		return "", errors.New("A complete local file path is required; type its workspace-relative path in browser preview")
	}
	return path, nil
}
