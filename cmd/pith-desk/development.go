package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/minifish-org/pith-desk/internal/desk"
	"github.com/minifish-org/pith-desk/internal/host"
)

func startHost(service *desk.Service, picker func() (string, error), devURL string, appearanceChanged ...func(desk.AppearanceMode)) (*host.Server, error) {
	if devURL != "" {
		return host.StartDevelopment(service, picker, devURL, appearanceChanged...)
	}
	return host.Start(service, picker, appearanceChanged...)
}

func applicationDataDir(requested string, development bool) (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("find application data directory: %w", err)
	}
	return resolveApplicationDataDir(requested, base, development)
}

func resolveApplicationDataDir(requested, configDir string, development bool) (string, error) {
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
		production, err = canonicalDataPath(production)
		if err != nil {
			return "", err
		}
		if dataPathsOverlap(dataDir, production) {
			return "", fmt.Errorf("development data must be separate from Pith Desk application data; choose a different --data-dir")
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
	// Compare filesystem identity too: EvalSymlinks preserves spelling, while
	// a case-insensitive volume can resolve another spelling to the same inode.
	ancestor := func(parent, child string) bool {
		parentInfo, err := os.Stat(parent)
		if err != nil {
			return false
		}
		for {
			if info, err := os.Stat(child); err == nil && os.SameFile(parentInfo, info) {
				return true
			}
			if filepath.Dir(child) == child {
				return false
			}
			child = filepath.Dir(child)
		}
	}
	if ancestor(a, b) || ancestor(b, a) {
		return true
	}
	// Conservatively reserve the default app name across case variants on
	// macOS, including when neither final directory has been created yet.
	if runtime.GOOS == "darwin" {
		a, b = strings.ToLower(a), strings.ToLower(b)
	}
	within := func(parent, child string) bool {
		rel, err := filepath.Rel(parent, child)
		return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
	}
	return within(a, b) || within(b, a)
}
