package workspacefs

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

func ResourceFile(path, dataDir string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	canonical, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", err
	}
	if Within(dataDir, canonical) {
		return "", errors.New("Resources cannot access private application data")
	}
	info, err := os.Stat(canonical)
	if err != nil || !info.Mode().IsRegular() {
		return "", errors.New("Open a regular instruction or skill file")
	}
	return canonical, nil
}

// Check discovery inputs before Pith reads their content. Regular instruction
// files may be inherited from ancestors. Symlinked instructions and project
// system prompts must resolve inside the workspace, as must skills/templates.
func ValidateResources(workspacePath, dataDir, configDir string) error {
	workspace, err := Directory(workspacePath)
	if err != nil {
		return err
	}
	private, err := Directory(dataDir)
	if err != nil {
		return err
	}
	if Within(private, workspace) || Within(workspace, private) {
		return errors.New("The workspace must not contain private application data")
	}
	for current := workspace; ; current = filepath.Dir(current) {
		for _, name := range []string{"AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"} {
			path := filepath.Join(current, name)
			if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
				continue
			} else if err != nil {
				return err
			}
			canonical, err := filepath.EvalSymlinks(path)
			if err != nil {
				return fmt.Errorf("Resolve instruction file: %w", err)
			}
			if Within(private, canonical) {
				return errors.New("Instruction files cannot point to private application data")
			}
			if canonical != path && !Within(workspace, canonical) {
				return errors.New("Instruction symlinks must resolve inside the selected workspace")
			}
			info, err := os.Stat(canonical)
			if err != nil {
				return err
			}
			if !info.IsDir() && !info.Mode().IsRegular() {
				return errors.New("Instruction files must be regular files")
			}
		}
		if filepath.Dir(current) == current {
			break
		}
	}
	for _, name := range []string{"SYSTEM.md", "APPEND_SYSTEM.md"} {
		path := filepath.Join(workspace, configDir, name)
		if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
			continue
		} else if err != nil {
			return err
		}
		canonical, err := ResourceFile(path, private)
		if err != nil {
			return err
		}
		if !Within(workspace, canonical) {
			return errors.New("Project system prompts must stay inside the selected workspace")
		}
	}
	for _, kind := range []string{"skills", "prompts"} {
		if err := validateResourceTree(filepath.Join(workspace, configDir, kind), workspace, private, map[string]bool{}); err != nil {
			return err
		}
	}
	return nil
}

func validateResourceTree(path, workspace, private string, visited map[string]bool) error {
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil {
		return fmt.Errorf("Resolve project resource: %w", err)
	}
	if !Within(workspace, canonical) || Within(private, canonical) {
		return errors.New("Project skills and prompts must stay inside the workspace and outside private application data")
	}
	info, err := os.Stat(canonical)
	if err != nil {
		return err
	}
	if info.Mode().IsRegular() {
		return nil
	}
	if !info.IsDir() {
		return errors.New("Project resources must be regular files or directories")
	}
	if visited[canonical] {
		return nil
	}
	visited[canonical] = true
	entries, err := os.ReadDir(canonical)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := validateResourceTree(filepath.Join(canonical, entry.Name()), workspace, private, visited); err != nil {
			return err
		}
	}
	return nil
}
