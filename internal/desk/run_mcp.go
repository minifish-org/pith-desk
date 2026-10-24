package desk

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
	"strings"
)

func (r *RunExecution) mcpToolDefinitions() []codingagent.ToolDefinition {
	s := r.dependencies
	s.mu.Lock()
	defer s.mu.Unlock()
	runtime := r.mcpRuntime
	if runtime == nil {
		return nil
	}
	definitions := runtime.ToolDefinitions()
	for i := range definitions {
		execute := definitions[i].Execute
		definitions[i].Execute = func(ctx context.Context, args json.RawMessage) (codingagent.ToolResult, error) {
			finished, watcherFinished := make(chan struct{}), make(chan struct{})
			go func() {
				defer close(watcherFinished)
				select {
				case <-ctx.Done():
					s.mu.Lock()
					if r.mcpRuntime == runtime {
						r.mcpRuntime = nil
					}
					s.changedLocked()
					s.mu.Unlock()
					closeMCPRuntime(runtime)
				case <-finished:
				}
			}()
			result, err := execute(ctx, args)
			close(finished)
			<-watcherFinished
			if err != nil {
				s.mu.Lock()
				message := s.redactMCP(err.Error())
				s.mu.Unlock()
				return result, errors.New(message)
			}
			return result, nil
		}
	}
	return definitions
}

func (r *RunExecution) connectMCP(ctx context.Context) error {
	s := r.dependencies
	s.mu.Lock()
	var configs []codingagent.MCPServerConfig
	for _, config := range s.connections.mcpConfigs {
		if config.Enabled {
			configs = append(configs, config.sdkConfig())
		}
	}
	s.mu.Unlock()
	if len(configs) == 0 {
		return nil
	}
	runtime, diagnostics := s.connections.loadMCPRuntime(ctx, configs, *s.files)
	s.mu.Lock()
	if *s.closed || ctx.Err() != nil {
		s.mu.Unlock()
		closeMCPRuntime(runtime)
		return context.Canceled
	}
	r.mcpRuntime = runtime
	var messages []string
	for _, diagnostic := range diagnostics {
		messages = append(messages, s.redactMCP(diagnostic.Error()))
	}
	s.mu.Unlock()
	if len(messages) > 0 {
		return fmt.Errorf("MCP connection: %s", strings.Join(messages, "; "))
	}
	return nil
}

func (r *RunExecution) closeMCP() {
	s := r.dependencies
	s.mu.Lock()
	runtime := r.mcpRuntime
	r.mcpRuntime = nil
	s.mu.Unlock()
	closeMCPRuntime(runtime)
}
