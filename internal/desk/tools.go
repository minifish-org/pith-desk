package desk

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	codingagent "github.com/minifish-org/pith/packages/coding-agent"
)

// os.Root guards every file operation, including symlink resolution at access
// time. This protects the file tools; an approved shell still has OS access.
type filePolicy struct {
	root        *os.Root
	path        string
	dataDir     string
	allowImages bool
}

func newFilePolicy(path, dataDir string) (*filePolicy, error) {
	path, err := canonicalDirectory(path)
	if err != nil {
		return nil, err
	}
	dataDir, err = canonicalDirectory(dataDir)
	if err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(path)
	if err != nil {
		return nil, err
	}
	return &filePolicy{root: root, path: path, dataDir: dataDir}, nil
}

func (p *filePolicy) checked(path string) (string, error) {
	abs := codingagent.ResolveToCwd(path, p.path)
	if !within(p.path, abs) {
		return "", errors.New("File tools can only access the selected workspace")
	}
	canonical, err := canonicalMissingPath(abs)
	if err != nil {
		return "", err
	}
	if !within(p.path, canonical) || within(p.dataDir, canonical) {
		return "", errors.New("This path is outside the selected workspace or contains private application data")
	}
	return filepath.Rel(p.path, canonical)
}

// Resolve the nearest existing ancestor, then append nonexistent components.
// Dangling symlinks are rejected instead of treated as a writable new path.
func canonicalMissingPath(path string) (string, error) {
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

func (p *filePolicy) ReadFile(path string) ([]byte, error) {
	rel, err := p.checked(path)
	if err != nil {
		return nil, err
	}
	info, err := p.root.Stat(rel)
	if err != nil || !info.Mode().IsRegular() {
		return nil, errors.New("Read a regular file inside the workspace")
	}
	return p.root.ReadFile(rel)
}

func (p *filePolicy) Access(path string) error {
	_, err := p.stat(path)
	return err
}

func (p *filePolicy) DetectImageMimeType(path string) (string, bool, error) {
	data, err := p.ReadFile(path)
	if err != nil {
		return "", false, err
	}
	if strings.HasPrefix(http.DetectContentType(data), "image/") {
		if !p.allowImages {
			return "", false, errors.New("Choose an image-capable model in Settings to read images")
		}
		mime := http.DetectContentType(data)
		if !supportedImageType(mime) {
			return "", false, errors.New("Use PNG, JPEG, GIF or WebP images")
		}
		return mime, true, nil
	}
	return "", false, nil
}

func (p *filePolicy) WriteFile(path string, content []byte) error {
	rel, err := p.checked(path)
	if err != nil {
		return err
	}
	if info, err := p.root.Stat(rel); err == nil && !info.Mode().IsRegular() {
		return errors.New("Write a regular file inside the workspace")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return p.root.WriteFile(rel, content, 0644)
}

func (p *filePolicy) Mkdir(path string) error {
	rel, err := p.checked(path)
	if err != nil {
		return err
	}
	return p.root.MkdirAll(rel, 0755)
}

func (p *filePolicy) CanonicalPath(path string) (string, error) {
	rel, err := p.checked(path)
	return filepath.Join(p.path, rel), err
}

func (p *filePolicy) stat(path string) (fs.FileInfo, error) {
	rel, err := p.checked(path)
	if err != nil {
		return nil, err
	}
	return p.root.Stat(rel)
}

type editOperations struct{ *filePolicy }

func (p editOperations) Stat(path string) (codingagent.EditFileInfo, error) {
	info, err := p.stat(path)
	if err != nil {
		return codingagent.EditFileInfo{}, err
	}
	return codingagent.EditFileInfo{IsFile: info.Mode().IsRegular()}, nil
}

type grepOperations struct{ *filePolicy }

func (p grepOperations) IsDirectory(path string) (bool, error) {
	info, err := p.stat(path)
	return err == nil && info.IsDir(), err
}

func (p grepOperations) ReadFile(path string) (string, error) {
	data, err := p.filePolicy.ReadFile(path)
	return string(data), err
}

type listOperations struct{ *filePolicy }

func (p listOperations) Exists(path string) (bool, error) {
	_, err := p.stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

func (p listOperations) Stat(path string) (codingagent.LsStat, error) {
	info, err := p.stat(path)
	return codingagent.LsStat{Directory: err == nil && info.IsDir()}, err
}

func (p listOperations) ReadDir(path string) ([]string, error) {
	rel, err := p.checked(path)
	if err != nil {
		return nil, err
	}
	entries, err := fs.ReadDir(p.root.FS(), filepath.ToSlash(rel))
	if err != nil {
		return nil, err
	}
	names := []string{}
	for _, entry := range entries {
		if _, err := p.checked(filepath.Join(path, entry.Name())); err == nil {
			names = append(names, entry.Name())
		}
	}
	return names, nil
}

type findOperations struct{ *filePolicy }

func (p findOperations) Exists(path string) (bool, error) {
	return listOperations{p.filePolicy}.Exists(path)
}

func (p findOperations) Glob(pattern, cwd string, options codingagent.FindGlobOptions) ([]string, error) {
	base, err := p.checked(cwd)
	if err != nil {
		return nil, err
	}
	matcher, err := globPattern(pattern)
	if err != nil {
		return nil, err
	}
	results := []string{}
	err = fs.WalkDir(p.root.FS(), filepath.ToSlash(base), func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if options.Limit > 0 && len(results) >= options.Limit {
			return fs.SkipAll
		}
		if entry.IsDir() && entry.Name() == ".git" {
			return fs.SkipDir
		}
		if entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		absolute := filepath.Join(p.path, filepath.FromSlash(path))
		if _, err := p.checked(absolute); err != nil {
			return nil
		}
		rel, err := filepath.Rel(cwd, absolute)
		if err != nil {
			return err
		}
		target := filepath.ToSlash(rel)
		if !strings.Contains(pattern, "/") {
			target = filepath.Base(rel)
		}
		if matcher.MatchString(target) {
			results = append(results, absolute)
		}
		return nil
	})
	return results, err
}

func globPattern(pattern string) (*regexp.Regexp, error) {
	// Validate character classes with the standard library before translating.
	if _, err := filepath.Match(strings.ReplaceAll(pattern, "**", "*"), ""); err != nil {
		return nil, fmt.Errorf("Invalid file pattern: %w", err)
	}
	var out strings.Builder
	out.WriteByte('^')
	for i := 0; i < len(pattern); i++ {
		switch pattern[i] {
		case '*':
			if i+1 < len(pattern) && pattern[i+1] == '*' {
				i++
				if i+1 < len(pattern) && pattern[i+1] == '/' {
					i++
					out.WriteString("(?:.*/)?")
				} else {
					out.WriteString(".*")
				}
			} else {
				out.WriteString("[^/]*")
			}
		case '?':
			out.WriteString("[^/]")
		case '[':
			j := i + 1
			for j < len(pattern) && pattern[j] != ']' {
				j++
			}
			out.WriteString(pattern[i : j+1])
			i = j
		default:
			out.WriteString(regexp.QuoteMeta(string(pattern[i])))
		}
	}
	out.WriteByte('$')
	return regexp.Compile(out.String())
}

func (s *Service) buildTools(policy *filePolicy) (*codingagent.ToolRegistry, error) {
	read := codingagent.CreateReadToolDefinition(policy.path, &codingagent.ReadToolOptions{Operations: policy})
	write := codingagent.CreateWriteToolDefinition(policy.path, &codingagent.WriteToolOptions{Operations: policy})
	edit := codingagent.CreateEditToolDefinition(policy.path, &codingagent.EditToolOptions{Operations: editOperations{policy}})
	grep := codingagent.CreateGrepToolDefinition(policy.path, &codingagent.GrepToolOptions{Operations: grepOperations{policy}})
	find := codingagent.CreateFindToolDefinition(policy.path, &codingagent.FindToolOptions{Operations: findOperations{policy}})
	ls := codingagent.CreateLsToolDefinition(policy.path, &codingagent.LsToolOptions{Operations: listOperations{policy}})
	shell := codingagent.CreateBashToolDefinition(policy.path, &codingagent.BashToolOptions{
		Prepare: func(execution *codingagent.BashExecutionContext, ctx context.Context) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			execution.InheritEnv = false
			execution.Env = map[string]string{}
			for _, name := range []string{"PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME"} {
				if value := os.Getenv(name); value != "" {
					execution.Env[name] = value
				}
			}
			return nil
		},
	})
	definitions := []codingagent.ToolDefinition{read, write, edit, grep, find, ls, shell}
	names := []string{"read_file", "write_file", "edit_file", "grep_files", "find_files", "list_files", "run_command"}
	for i := range definitions {
		definitions[i].Name = names[i]
	}
	external := map[string]bool{}
	for _, definition := range s.mcpDefinitions() {
		external[definition.Name] = true
		definitions = append(definitions, definition)
	}
	s.mu.Lock()
	s.externalTools = external
	s.mu.Unlock()
	definitions[4].Description = "Find files by glob pattern inside the workspace. Directory symlinks and .git are excluded."
	registry, err := codingagent.NewToolRegistry(policy.path, definitions, names, codingagent.AllToolNames,
		codingagent.ToolHooks{Before: func(ctx context.Context, call codingagent.ToolCall) error {
			if external[call.Name] {
				return s.requestApproval(ctx, call)
			}
			switch call.Name {
			case "read_file", "write_file", "edit_file", "grep_files", "find_files", "list_files":
				var args struct {
					Path string `json:"path"`
				}
				if err := json.Unmarshal(call.Arguments, &args); err != nil {
					return err
				}
				if _, err := policy.checked(args.Path); err != nil {
					return err
				}
			case "run_command", codingagent.CodemodeToolName, codingagent.ToolSearchToolName:
			default:
				return errors.New("This tool is not enabled in Pith Desk")
			}
			switch call.Name {
			case "write_file", "edit_file", "run_command":
				return s.requestApproval(ctx, call)
			}
			return ctx.Err()
		}})
	if err != nil {
		return nil, err
	}
	complete := false
	defer func() {
		if !complete {
			_ = registry.CloseTools()
		}
	}()
	search, err := codingagent.CreateToolSearchTool(registry)
	if err != nil {
		return nil, err
	}
	if err = registry.Register(search); err != nil {
		return nil, err
	}
	code, err := codingagent.NewCodemodeTool(registry, nil)
	if err != nil {
		return nil, err
	}
	if err = registry.Register(code); err != nil {
		return nil, err
	}
	names = append(names, codingagent.ToolSearchToolName, codingagent.CodemodeToolName)
	if err = registry.SetActive(names); err != nil {
		return nil, err
	}
	complete = true
	return registry, nil
}

func (s *Service) requestApproval(ctx context.Context, call codingagent.ToolCall) error {
	select {
	case s.approvalGate <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() { <-s.approvalGate }()
	approval := &Approval{ID: newID(), ToolName: call.Name, Args: append(json.RawMessage(nil), call.Arguments...)}
	if call.Name == "run_command" {
		approval.Warning = "This command runs with your computer account's permissions. It can access files and network outside the workspace. There is no OS sandbox."
	} else if strings.HasPrefix(call.Name, "mcp__") {
		approval.Warning = "This enabled MCP tool uses the external server's permissions. It can access or change data outside this workspace."
	}
	decision := make(chan bool, 1)
	s.mu.Lock()
	if s.closed || s.aborting || ctx.Err() != nil {
		s.mu.Unlock()
		return context.Canceled
	}
	// A previous call may have waited in the gate while the user changed mode.
	// Recheck under the service lock immediately before creating an approval.
	if s.permissionAllowsLocked(call.Name) {
		s.mu.Unlock()
		return ctx.Err()
	}
	s.state.PendingApproval, s.approval = approval, decision
	s.approvalCtx = ctx
	s.changedLocked()
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		if s.state.PendingApproval != nil && s.state.PendingApproval.ID == approval.ID {
			s.state.PendingApproval, s.approval = nil, nil
			s.approvalCtx = nil
			s.changedLocked()
		}
		s.mu.Unlock()
	}()
	select {
	case allowed := <-decision:
		if !allowed {
			return errors.New("The user declined this action; do not repeat it without a new request")
		}
		return ctx.Err()
	case <-ctx.Done():
		return ctx.Err()
	}
}
