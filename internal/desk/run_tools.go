package desk

import (
	"context"
	"encoding/json"
	"errors"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
	"os"
)

func (r *RunExecution) buildTools(policy *filePolicy) (*codingagent.ToolRegistry, error) {
	s := r.dependencies
	read := codingagent.CreateReadToolDefinition(policy.path, &codingagent.ReadToolOptions{Operations: policy})
	write := withWriteChangeStats(policy, codingagent.CreateWriteToolDefinition(policy.path, &codingagent.WriteToolOptions{Operations: policy}))
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
	for _, definition := range r.mcpToolDefinitions() {
		external[definition.Name] = true
		definitions = append(definitions, definition)
	}
	s.mu.Lock()
	r.externalTools = external
	s.mu.Unlock()
	definitions[4].Description = "Find files by glob pattern inside the workspace. Directory symlinks and .git are excluded."
	registry, err := codingagent.NewToolRegistry(policy.path, definitions, names, codingagent.AllToolNames,
		codingagent.ToolHooks{Before: func(ctx context.Context, call codingagent.ToolCall) error {
			if external[call.Name] {
				return r.requestApproval(ctx, call)
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
				return r.requestApproval(ctx, call, policy)
			}
			return ctx.Err()
		}, After: r.recordNestedFileChange})
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
	executeCode := code.Execute
	code.Execute = func(ctx context.Context, args json.RawMessage) (codingagent.ToolResult, error) {
		return executeCode(context.WithValue(ctx, codemodeContextKey{}, true), args)
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
