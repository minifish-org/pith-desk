package appdata

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/minifish-org/pith-desk/internal/workspacefs"
)

func Dir(requested string, development bool) (string, error) {
	if requested != "" && !development {
		return canonicalDataPath(requested)
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("find application data directory: %w", err)
	}
	return resolveDataDir(requested, base, development)
}

func resolveDataDir(requested, configDir string, development bool) (string, error) {
	production := filepath.Join(configDir, "Pith Desk")
	if requested == "" {
		requested = production
		if development {
			requested = filepath.Join(configDir, "Pith Desk Development")
		}
	}
	dataDir, err := canonicalDataPath(requested)
	if err != nil {
		return "", err
	}
	if development {
		for _, reserved := range []string{production, filepath.Join(configDir, "Pith Desk Server")} {
			reserved, err = canonicalDataPath(reserved)
			if err != nil {
				return "", err
			}
			if dataPathsOverlap(dataDir, reserved) {
				return "", fmt.Errorf("development data must be separate from Pith Desk application data; choose a different --data-dir")
			}
		}
	}
	return dataDir, nil
}

// Resolve the existing parent as well as the final directory: a not-yet-created
// child of a symlink must not evade the development/production separation.
func canonicalDataPath(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	parent, suffix := absolute, ""
	for {
		canonical, err := filepath.EvalSymlinks(parent)
		if err == nil {
			return filepath.Join(canonical, suffix), nil
		}
		if !os.IsNotExist(err) || filepath.Dir(parent) == parent {
			return "", fmt.Errorf("resolve application data directory: %w", err)
		}
		suffix = filepath.Join(filepath.Base(parent), suffix)
		parent = filepath.Dir(parent)
	}
}

func dataPathsOverlap(a, b string) bool {
	if workspacefs.Within(a, b) || workspacefs.Within(b, a) {
		return true
	}
	// Conservatively reserve the default app name across case variants on
	// macOS, including when neither final directory has been created yet.
	if runtime.GOOS == "darwin" {
		a, b = strings.ToLower(a), strings.ToLower(b)
		return workspacefs.Within(a, b) || workspacefs.Within(b, a)
	}
	return false
}
