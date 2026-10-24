package desk

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/minifish-org/pith-desk/internal/workspacefs"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
)

type ResourceInput struct {
	WorkspaceID string `json:"workspaceId"`
	Kind        string `json:"kind"`
	Name        string `json:"name"`
	Path        string `json:"path"`
	Content     string `json:"content"`
	Remove      bool   `json:"remove"`
}

var resourceName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]*$`)

func (s *Service) SaveResource(input ResourceInput) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.saveResourceLocked(input)
	return err
}

func (s *Service) saveResourceLocked(input ResourceInput) (string, error) {
	if err := s.workspaceIdleLocked(input.WorkspaceID); err != nil {
		return "", err
	}
	w, ok := s.workspaceLocked(input.WorkspaceID)
	if !ok {
		return "", errors.New("Workspace not found")
	}
	if err := workspacefs.ValidateResources(w.Path, s.dataDir, codingagent.ConfigDirName); err != nil {
		return "", err
	}
	path := input.Path
	create := path == ""
	if create {
		switch input.Kind {
		case "instructions":
			path = filepath.Join(w.Path, "AGENTS.md")
		case "skill", "template":
			if !resourceName.MatchString(input.Name) {
				return "", errors.New("Use letters, numbers, hyphens, or underscores for resource names")
			}
			path = filepath.Join(w.Path, ".pi", "prompts", input.Name+".md")
			if input.Kind == "skill" {
				path = filepath.Join(w.Path, ".pi", "skills", input.Name, "SKILL.md")
			}
		default:
			return "", errors.New("Choose instructions, skill, or template")
		}
	} else {
		inventory, err := s.resourcesLocked(w.ID)
		if err != nil {
			return "", err
		}
		found := false
		for _, item := range inventory.Instructions {
			found = found || item.Path == path
		}
		for _, item := range append(inventory.Skills, inventory.Templates...) {
			found = found || item.Path == path
		}
		if !found {
			return "", errors.New("Edit a discovered workspace resource")
		}
	}
	if !workspacefs.Within(w.Path, path) {
		return "", errors.New("Inherited instructions are read-only; edit the workspace's AGENTS.md instead")
	}
	rel, err := filepath.Rel(w.Path, path)
	if err != nil {
		return "", err
	}
	root, err := os.OpenRoot(w.Path)
	if err != nil {
		return "", err
	}
	defer root.Close()
	if input.Remove {
		if create {
			return "", errors.New("Choose an existing resource to delete")
		}
		if err = root.Remove(rel); err != nil {
			return "", err
		}
		// Remove the skill's empty directory only; never remove other files.
		if strings.HasSuffix(rel, string(filepath.Separator)+"SKILL.md") {
			_ = root.Remove(filepath.Dir(rel))
		}
	} else {
		if strings.TrimSpace(input.Content) == "" {
			return "", errors.New("Enter resource content")
		}
		if create {
			if err = root.MkdirAll(filepath.Dir(rel), 0755); err != nil {
				return "", err
			}
		}
		writePath := rel
		if !create {
			// Save edits by rename so a failed write cannot truncate the old file.
			writePath = filepath.Join(filepath.Dir(rel), ".desk-resource-"+newID())
		}
		file, err := root.OpenFile(writePath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
		if err != nil {
			return "", err
		}
		saved := false
		defer func() {
			if !saved {
				_ = root.Remove(writePath)
			}
		}()
		_, err = file.WriteString(input.Content)
		if err == nil {
			err = file.Sync()
		}
		closeErr := file.Close()
		if err != nil {
			return "", err
		}
		if closeErr != nil {
			return "", closeErr
		}
		if !create {
			if err = root.Rename(writePath, rel); err != nil {
				return "", err
			}
		}
		saved = true
	}
	s.changedLocked()
	return path, nil
}

func (s *Service) ResourceContent(workspaceID, path string) (map[string]string, error) {
	verified, err := s.ResolveResourceFile(workspaceID, path)
	if err != nil {
		return nil, err
	}
	content, err := os.ReadFile(verified)
	if err != nil {
		return nil, err
	}
	return map[string]string{"content": string(content)}, nil
}
