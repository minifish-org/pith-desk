// Package workspacefs owns path validation shared by workspace tools and
// resource discovery. It has no SDK, catalog, task or application dependency.
package workspacefs

import (
	"errors"
	"fmt"
	"io"
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

// ReadableDirectory checks the server account's access without requiring write
// permission: read-only workspaces remain useful for inspection tasks.
func ReadableDirectory(path string) (string, error) {
	abs, err := Directory(path)
	if err != nil {
		return "", err
	}
	// Stat the child dot to check traversal as well as reading directory names.
	if _, err := os.Stat(abs + string(filepath.Separator) + "."); err != nil {
		return "", fmt.Errorf("Access folder: %w", err)
	}
	dir, err := os.Open(abs)
	if err != nil {
		return "", fmt.Errorf("Read folder: %w", err)
	}
	defer dir.Close()
	if _, err := dir.ReadDir(1); err != nil && !errors.Is(err, io.EOF) {
		return "", fmt.Errorf("Read folder: %w", err)
	}
	return abs, nil
}

// Within accepts nonexistent descendants and compares existing ancestors by
// filesystem identity. EvalSymlinks preserves case on case-insensitive volumes.
func Within(parent, child string) bool {
	rel, err := filepath.Rel(parent, child)
	if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return true
	}
	parentInfo, err := os.Stat(parent)
	if err != nil {
		return false
	}
	for child = filepath.Clean(child); ; child = filepath.Dir(child) {
		if info, err := os.Stat(child); err == nil && os.SameFile(parentInfo, info) {
			return true
		}
		if filepath.Dir(child) == child {
			return false
		}
	}
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
