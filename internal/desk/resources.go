package desk

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

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
	if err := validateRuntimeResources(workspace.Path, s.dataDir); err != nil {
		return ResourceInventory{}, err
	}
	mode := PermissionAsk
	if index := s.conversationIndexLocked(s.state.ActiveID); index >= 0 && s.state.Conversations[index].WorkspaceID == workspaceID {
		mode = normalizedPermissionMode(s.state.Conversations[index].PermissionMode)
	}
	loaded, err := codingagent.LoadResources(codingagent.ResourceOptions{Cwd: workspace.Path, SystemPrompt: deskPrompt(mode)})
	if err != nil {
		return ResourceInventory{}, err
	}
	inventory := ResourceInventory{WorkspaceID: workspaceID, Instructions: []InstructionResource{}, Skills: []SkillResource{}, Diagnostics: append([]string{}, loaded.Diagnostics...)}
	for _, path := range loaded.ContextFiles {
		canonical, err := checkedResourceFile(path, s.dataDir)
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
		canonical, err := checkedResourceFile(skill.File, s.dataDir)
		if err != nil || !within(workspace.Path, canonical) {
			inventory.Diagnostics = append(inventory.Diagnostics, fmt.Sprintf("Skill %q is not a regular file inside the workspace", skill.Name))
			continue
		}
		inventory.Skills = append(inventory.Skills, SkillResource{Name: skill.Name, Path: canonical, Description: skill.Description})
	}
	inventory.Templates = []SkillResource{}
	for _, template := range loaded.Templates {
		canonical, err := checkedResourceFile(template.File, s.dataDir)
		if err != nil || !within(workspace.Path, canonical) {
			continue
		}
		inventory.Templates = append(inventory.Templates, SkillResource{Name: template.Name, Path: canonical, Description: template.Description})
	}
	return inventory, nil
}

func (s *Service) CreateInstructions(workspaceID string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.idleLocked(); err != nil {
		return "", err
	}
	workspace, ok := s.workspaceLocked(workspaceID)
	if !ok {
		return "", errors.New("Workspace not found")
	}
	if err := validateRuntimeResources(workspace.Path, s.dataDir); err != nil {
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
	canonical, err := checkedResourceFile(path, s.dataDir)
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

func checkedResourceFile(path, dataDir string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	canonical, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", err
	}
	if within(dataDir, canonical) {
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
func validateRuntimeResources(workspacePath, dataDir string) error {
	workspace, err := canonicalDirectory(workspacePath)
	if err != nil {
		return err
	}
	private, err := canonicalDirectory(dataDir)
	if err != nil {
		return err
	}
	if within(private, workspace) || within(workspace, private) {
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
			if within(private, canonical) {
				return errors.New("Instruction files cannot point to private application data")
			}
			if canonical != path && !within(workspace, canonical) {
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
		path := filepath.Join(workspace, codingagent.ConfigDirName, name)
		if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
			continue
		} else if err != nil {
			return err
		}
		canonical, err := checkedResourceFile(path, private)
		if err != nil {
			return err
		}
		if !within(workspace, canonical) {
			return errors.New("Project system prompts must stay inside the selected workspace")
		}
	}
	for _, kind := range []string{"skills", "prompts"} {
		if err := validateResourceTree(filepath.Join(workspace, codingagent.ConfigDirName, kind), workspace, private, map[string]bool{}); err != nil {
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
	if !within(workspace, canonical) || within(private, canonical) {
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
