package desk

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/minifish-org/pith-desk/internal/workspacefs"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
)

type InstructionResource struct {
	Content string `json:"content"`
	Name    string `json:"name"`
	Path    string `json:"path"`
}

type SkillResource struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	Description string `json:"description"`
}

type ResourceInventory struct {
	WorkspaceID  string                `json:"workspaceId"`
	Instructions []InstructionResource `json:"instructions"`
	Skills       []SkillResource       `json:"skills"`
	Templates    []SkillResource       `json:"templates"`
	Diagnostics  []string              `json:"diagnostics"`
}

func (s *Service) Resources(workspaceID string) (ResourceInventory, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return ResourceInventory{}, errors.New("Pith Desk has closed")
	}
	return s.resourcesLocked(workspaceID)
}

func (s *Service) resourcesLocked(workspaceID string) (ResourceInventory, error) {
	workspace, ok := s.workspaceLocked(workspaceID)
	if !ok {
		return ResourceInventory{}, errors.New("Workspace not found")
	}
	if err := workspacefs.ValidateResources(workspace.Path, s.dataDir, codingagent.ConfigDirName); err != nil {
		return ResourceInventory{}, err
	}
	mode := PermissionAsk
	if index := s.conversationIndexLocked(s.catalog.ActiveID); index >= 0 && s.catalog.Conversations[index].WorkspaceID == workspaceID {
		mode = normalizedPermissionMode(s.catalog.Conversations[index].PermissionMode)
	}
	loaded, err := codingagent.LoadResources(codingagent.ResourceOptions{Cwd: workspace.Path, SystemPrompt: deskPrompt(mode)})
	if err != nil {
		return ResourceInventory{}, err
	}
	inventory := ResourceInventory{WorkspaceID: workspaceID, Instructions: []InstructionResource{}, Skills: []SkillResource{}, Diagnostics: append([]string{}, loaded.Diagnostics...)}
	for _, path := range loaded.ContextFiles {
		canonical, err := workspacefs.ResourceFile(path, s.dataDir)
		if err != nil {
			inventory.Diagnostics = append(inventory.Diagnostics, err.Error())
			continue
		}
		content, err := os.ReadFile(canonical)
		if err != nil {
			inventory.Diagnostics = append(inventory.Diagnostics, err.Error())
			continue
		}
		inventory.Instructions = append(inventory.Instructions, InstructionResource{Name: filepath.Base(path), Path: canonical, Content: string(content)})
	}
	for _, skill := range loaded.Skills {
		canonical, err := workspacefs.ResourceFile(skill.File, s.dataDir)
		if err != nil || !workspacefs.Within(workspace.Path, canonical) {
			inventory.Diagnostics = append(inventory.Diagnostics, fmt.Sprintf("Skill %q is not a regular file inside the workspace", skill.Name))
			continue
		}
		inventory.Skills = append(inventory.Skills, SkillResource{Name: skill.Name, Path: canonical, Description: skill.Description})
	}
	inventory.Templates = []SkillResource{}
	for _, template := range loaded.Templates {
		canonical, err := workspacefs.ResourceFile(template.File, s.dataDir)
		if err != nil || !workspacefs.Within(workspace.Path, canonical) {
			continue
		}
		inventory.Templates = append(inventory.Templates, SkillResource{Name: template.Name, Path: canonical, Description: template.Description})
	}
	return inventory, nil
}

func (s *Service) CreateInstructions(workspaceID string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.workspaceIdleLocked(workspaceID); err != nil {
		return "", err
	}
	workspace, ok := s.workspaceLocked(workspaceID)
	if !ok {
		return "", errors.New("Workspace not found")
	}
	if err := workspacefs.ValidateResources(workspace.Path, s.dataDir, codingagent.ConfigDirName); err != nil {
		return "", err
	}
	root, err := os.OpenRoot(workspace.Path)
	if err != nil {
		return "", err
	}
	defer root.Close()
	file, err := root.OpenFile("AGENTS.md", os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
	if errors.Is(err, os.ErrExist) {
		return "", errors.New("AGENTS.md already exists; your instructions were left unchanged")
	}
	if err != nil {
		return "", err
	}
	const template = "# Workspace instructions\n\nDescribe the project and how you want Pith to help in this workspace.\n\n## Project context\n\n<!-- Add the purpose of this workspace and any useful background. -->\n\n## Preferences\n\n<!-- Add conventions, preferred formats, and important boundaries. -->\n"
	_, writeErr := file.WriteString(template)
	if writeErr == nil {
		writeErr = file.Sync()
	}
	closeErr := file.Close()
	if writeErr != nil {
		_ = root.Remove("AGENTS.md")
		return "", writeErr
	}
	if closeErr != nil {
		return "", closeErr
	}
	s.changedLocked()
	return filepath.Join(workspace.Path, "AGENTS.md"), nil
}

func (s *Service) ResolveResourceFile(workspaceID, path string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return "", errors.New("Pith Desk has closed")
	}
	inventory, err := s.resourcesLocked(workspaceID)
	if err != nil {
		return "", err
	}
	canonical, err := workspacefs.ResourceFile(path, s.dataDir)
	if err != nil {
		return "", err
	}
	for _, resource := range inventory.Instructions {
		if resource.Path == canonical {
			return canonical, nil
		}
	}
	for _, resource := range inventory.Skills {
		if resource.Path == canonical {
			return canonical, nil
		}
	}
	for _, resource := range inventory.Templates {
		if resource.Path == canonical {
			return canonical, nil
		}
	}
	return "", errors.New("Open a discovered instruction, skill, or template from this workspace")
}
