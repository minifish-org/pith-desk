// Package workspacefs owns path validation shared by workspace tools and
// resource discovery. It has no SDK, catalog, task or application dependency.
package workspacefs

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func Directory(path string) (string, error) {
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

func Within(parent, child string) bool {
	rel, err := filepath.Rel(parent, child)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// Resolve the nearest existing ancestor, then append nonexistent components.
// Dangling symlinks are rejected instead of treated as a writable new path.
func CanonicalMissingPath(path string) (string, error) {
	current := path
	var missing []string
	for {
		_, err := os.Lstat(current)
		if err == nil {
			resolved, err := filepath.EvalSymlinks(current)
			if err != nil {
				return "", err
			}
			for i := len(missing) - 1; i >= 0; i-- {
				resolved = filepath.Join(resolved, missing[i])
			}
			return resolved, nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", err
		}
		missing = append(missing, filepath.Base(current))
		current = parent
	}
}

// Relative checks an already-resolved absolute tool path. SDK-specific cwd
// and tilde expansion stays in the caller. os.Root still guards actual access.
func Relative(workspace, private, abs string) (string, error) {
	if !Within(workspace, abs) {
		return "", errors.New("File tools can only access the selected workspace")
	}
	canonical, err := CanonicalMissingPath(abs)
	if err != nil {
		return "", err
	}
	if !Within(workspace, canonical) || Within(private, canonical) {
		return "", errors.New("This path is outside the selected workspace or contains private application data")
	}
	return filepath.Rel(workspace, canonical)
}
