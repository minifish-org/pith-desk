package desk

import (
	"context"
	"errors"
	"fmt"
	"strings"

	codingagent "github.com/minifish-org/pith/packages/coding-agent"
)

// These explicit preview-connect helpers are used only by tests. The product
// connects MCP servers as part of a task in run_mcp.go.
func (s *Service) ConnectMCP(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := s.acquireMCP(ctx); err != nil {
		return err
	}
	defer s.releaseMCP()
	s.mu.Lock()
	if s.closed || s.anyRunningLocked() {
		s.mu.Unlock()
		return errors.New("Wait for the task to stop before connecting MCP servers")
	}
	configs := make([]codingagent.MCPServerConfig, 0, len(s.connections.mcpConfigs))
	for _, config := range s.connections.mcpConfigs {
		if config.Enabled {
			if err := validateMCP(config); err != nil {
				s.mu.Unlock()
				return err
			}
			configs = append(configs, config.sdkConfig())
		}
	}
	if len(configs) == 0 {
		s.mu.Unlock()
		return nil
	}
	connectCtx, cancel := context.WithCancel(ctx)
	old := s.connections.beginMCPPreview(cancel)
	s.changedLocked()
	s.mu.Unlock()
	defer cancel()
	closeMCPRuntime(old)
	runtime, diagnostics := s.loadMCPRuntime(connectCtx, configs)
	s.mu.Lock()
	s.connections.endMCPPreview()
	if s.closed || connectCtx.Err() != nil {
		s.changedLocked()
		s.mu.Unlock()
		closeMCPRuntime(runtime)
		if connectCtx.Err() != nil {
			return connectCtx.Err()
		}
		return errors.New("Pith Desk has closed")
	}
	s.connections.setMCPPreview(runtime)
	var messages []string
	for _, diagnostic := range diagnostics {
		messages = append(messages, s.redactMCPLocked(diagnostic.Error()))
	}
	s.changedLocked()
	s.mu.Unlock()
	if len(messages) > 0 {
		return fmt.Errorf("MCP connection: %s", strings.Join(messages, "; "))
	}
	return nil
}

func (s *Service) DisconnectMCP() error {
	if err := s.acquireMCP(context.Background()); err != nil {
		return err
	}
	defer s.releaseMCP()
	s.mu.Lock()
	if err := s.idleLocked(); err != nil {
		s.mu.Unlock()
		return err
	}
	runtime := s.connections.takeMCPPreview()
	s.changedLocked()
	s.mu.Unlock()
	closeMCPRuntime(runtime)
	return nil
}
