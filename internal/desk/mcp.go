package desk

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	codingagent "github.com/minifish-org/pith/packages/coding-agent"
	"github.com/minifish-org/pith/packages/mcp"
)

type MCPInput struct {
	Name             string            `json:"name"`
	Type             string            `json:"type"`
	URL              string            `json:"url,omitempty"`
	Command          string            `json:"command,omitempty"`
	Args             []string          `json:"args"`
	BearerToken      string            `json:"bearerToken,omitempty"`
	ClearBearerToken bool              `json:"clearBearerToken,omitempty"`
	Enabled          bool              `json:"enabled"`
	Env              map[string]string `json:"env,omitempty"`
	ClearEnv         bool              `json:"clearEnv,omitempty"`
}

type MCPServerView struct {
	Name           string   `json:"name"`
	Type           string   `json:"type"`
	URL            string   `json:"url,omitempty"`
	Command        string   `json:"command,omitempty"`
	Args           []string `json:"args"`
	Enabled        bool     `json:"enabled"`
	HasBearerToken bool     `json:"hasBearerToken"`
	Status         string   `json:"status"`
	ToolCount      int      `json:"toolCount"`
	Error          string   `json:"error,omitempty"`
	EnvKeys        []string `json:"envKeys"`
}

type savedMCP struct {
	Name        string            `json:"name"`
	Type        string            `json:"type"`
	URL         string            `json:"url,omitempty"`
	Command     string            `json:"command,omitempty"`
	Args        []string          `json:"args"`
	BearerToken string            `json:"bearerToken,omitempty"`
	Enabled     bool              `json:"enabled"`
	Env         map[string]string `json:"env,omitempty"`
}

func (s *Service) ListMCP() []MCPServerView {
	s.mu.Lock()
	defer s.mu.Unlock()
	statuses := map[string]codingagent.MCPServerStatus{}
	if s.mcpRuntime != nil {
		for _, status := range s.mcpRuntime.Statuses() {
			statuses[status.Name] = status
		}
	}
	views := make([]MCPServerView, 0, len(s.mcpConfigs))
	for _, config := range s.mcpConfigs {
		view := MCPServerView{Name: config.Name, Type: config.Type, URL: config.URL, Command: config.Command,
			Args: append([]string{}, config.Args...), Enabled: config.Enabled, HasBearerToken: config.BearerToken != "", Status: "disconnected"}
		view.EnvKeys = []string{}
		for key := range config.Env {
			view.EnvKeys = append(view.EnvKeys, key)
		}
		sort.Strings(view.EnvKeys)
		if config.Enabled && s.mcpConnecting {
			view.Status = "connecting"
		} else if status, ok := statuses[config.Name]; ok && config.Enabled {
			view.ToolCount = status.ToolCount
			if status.Error != "" {
				view.Status, view.Error = "error", s.redactMCPLocked(status.Error)
			} else if status.Connected {
				view.Status = "connected"
			}
		}
		views = append(views, view)
	}
	return views
}

func (s *Service) SaveMCP(input MCPInput) error {
	if err := s.acquireMCP(context.Background()); err != nil {
		return err
	}
	defer s.releaseMCP()
	s.mu.Lock()
	if err := s.idleLocked(); err != nil {
		s.mu.Unlock()
		return err
	}
	next := savedMCP{Name: strings.TrimSpace(input.Name), Type: strings.TrimSpace(input.Type),
		URL: strings.TrimSpace(input.URL), Command: strings.TrimSpace(input.Command), Args: append([]string{}, input.Args...), Enabled: input.Enabled, Env: map[string]string{}}
	if next.Type == "" {
		next.Type = "stdio"
	}
	index := -1
	for i, existing := range s.mcpConfigs {
		if existing.Name == next.Name {
			index, next.BearerToken = i, existing.BearerToken
			if !input.ClearEnv {
				for key, value := range existing.Env {
					next.Env[key] = value
				}
			}
		} else if codingagent.MCPNamespace(existing.Name) == codingagent.MCPNamespace(next.Name) {
			s.mu.Unlock()
			return errors.New("Choose a distinct MCP server name; dashes and underscores share a tool namespace")
		}
	}
	for key, value := range input.Env {
		next.Env[key] = value
	}
	if input.BearerToken != "" {
		next.BearerToken = strings.TrimSpace(input.BearerToken)
	}
	if input.ClearBearerToken || next.Type != "http" {
		next.BearerToken = ""
	}
	if err := validateMCP(next); err != nil {
		s.mu.Unlock()
		return err
	}
	configs := append([]savedMCP{}, s.mcpConfigs...)
	if index < 0 {
		configs = append(configs, next)
	} else {
		configs[index] = next
	}
	if err := writeJSON(filepath.Join(s.dataDir, "mcp.json"), configs); err != nil {
		s.mu.Unlock()
		return err
	}
	old := s.mcpRuntime
	s.mcpConfigs, s.mcpRuntime = configs, nil
	s.changedLocked()
	s.mu.Unlock()
	closeMCPRuntime(old)
	return nil
}

func (s *Service) RemoveMCP(name string) error {
	if err := s.acquireMCP(context.Background()); err != nil {
		return err
	}
	defer s.releaseMCP()
	s.mu.Lock()
	if err := s.idleLocked(); err != nil {
		s.mu.Unlock()
		return err
	}
	configs := make([]savedMCP, 0, len(s.mcpConfigs))
	found := false
	for _, config := range s.mcpConfigs {
		if config.Name == name {
			found = true
		} else {
			configs = append(configs, config)
		}
	}
	if !found {
		s.mu.Unlock()
		return errors.New("MCP server not found")
	}
	if err := writeJSON(filepath.Join(s.dataDir, "mcp.json"), configs); err != nil {
		s.mu.Unlock()
		return err
	}
	old := s.mcpRuntime
	s.mcpConfigs, s.mcpRuntime = configs, nil
	s.changedLocked()
	s.mu.Unlock()
	closeMCPRuntime(old)
	return nil
}

func validateMCP(config savedMCP) error {
	for key, value := range config.Env {
		if key == "" || strings.ContainsAny(key, "=\x00") || strings.ContainsRune(value, 0) {
			return errors.New("MCP environment keys cannot be empty or contain = or null; values cannot contain null")
		}
	}
	if strings.ContainsAny(config.BearerToken, "\r\n\x00") {
		return errors.New("Enter a bearer token without line breaks")
	}
	if config.Type == "http" {
		u, err := url.Parse(config.URL)
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			return errors.New("Enter an HTTP or HTTPS MCP URL without credentials, query, or fragment")
		}
	} else if config.Type == "stdio" {
		if config.Command == "" || strings.ContainsRune(config.Command, 0) {
			return errors.New("Enter the MCP executable command")
		}
		for _, arg := range config.Args {
			if strings.ContainsRune(arg, 0) {
				return errors.New("MCP arguments cannot contain a null character")
			}
		}
	}
	return codingagent.ValidateMCPServerConfig(config.sdkConfig())
}

func (config savedMCP) sdkConfig() codingagent.MCPServerConfig {
	enabled := config.Enabled
	result := codingagent.MCPServerConfig{Name: config.Name, Type: config.Type, URL: config.URL,
		Command: config.Command, Args: append([]string{}, config.Args...), Enabled: &enabled, Exposure: codingagent.MCPExposureDirect}
	result.Env = map[string]string{}
	for key, value := range config.Env {
		result.Env[key] = value
	}
	if config.BearerToken != "" {
		result.Headers = map[string]string{"Authorization": "Bearer " + config.BearerToken}
	}
	return result
}

func (s *Service) ConnectMCP(ctx context.Context) error { return s.connectMCP(ctx, false) }

func (s *Service) connectMCP(ctx context.Context, duringRun bool) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := s.acquireMCP(ctx); err != nil {
		return err
	}
	defer s.releaseMCP()
	s.mu.Lock()
	if s.closed || (!duringRun && s.state.Running) {
		s.mu.Unlock()
		return errors.New("Wait for the task to stop before connecting MCP servers")
	}
	if duringRun && s.mcpRuntime != nil {
		s.mu.Unlock()
		return nil
	}
	configs := make([]codingagent.MCPServerConfig, 0, len(s.mcpConfigs))
	for _, config := range s.mcpConfigs {
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
	s.mcpConnectCancel, s.mcpConnecting = cancel, true
	old := s.mcpRuntime
	s.mcpRuntime = nil
	s.changedLocked()
	s.mu.Unlock()
	defer cancel()
	closeMCPRuntime(old)
	runtime := codingagent.NewMCPRuntime(codingagent.MCPRuntimeOptions{ClientName: "pith-desk", ClientVersion: "1",
		TransportFactory: safeMCPTransport,
		OnError: func(_ string, _ error) {
			// Pith's runtime supplies connection status diagnostics. Avoid logging
			// raw transport errors, which may contain echoed HTTP credentials.
		},
	})
	loadFinished, watcherFinished := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(watcherFinished)
		select {
		case <-connectCtx.Done():
			// This SDK's HTTP Send uses the transport lifetime context. Close
			// cancels it even when initialization is awaiting response headers.
			closeMCPRuntime(runtime)
		case <-loadFinished:
		}
	}()
	diagnostics := runtime.Load(connectCtx, configs)
	close(loadFinished)
	<-watcherFinished
	s.mu.Lock()
	s.mcpConnectCancel, s.mcpConnecting = nil, false
	if s.closed || connectCtx.Err() != nil {
		s.changedLocked()
		s.mu.Unlock()
		closeMCPRuntime(runtime)
		if connectCtx.Err() != nil {
			return connectCtx.Err()
		}
		return errors.New("Pith Desk has closed")
	}
	s.mcpRuntime = runtime
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

func safeMCPTransport(config codingagent.MCPServerConfig) (mcp.Transport, error) {
	if config.Type == "http" {
		headers := map[string][]string{}
		for key, value := range config.Headers {
			headers[key] = []string{value}
		}
		return mcp.NewStreamableHTTPTransport(config.URL, &mcp.HTTPOptions{Headers: headers}), nil
	}
	inherit := false
	values := map[string]string{}
	for _, name := range []string{"PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME"} {
		if value := os.Getenv(name); value != "" {
			values[name] = value
		}
	}
	for key, value := range config.Env {
		values[key] = value
	}
	keys := []string{}
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	env := []string{}
	for _, key := range keys {
		env = append(env, key+"="+values[key])
	}
	return mcp.NewStdioTransport(config.Command, config.Args, &mcp.StdioOptions{Env: env, InheritEnv: &inherit}), nil
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
	runtime := s.mcpRuntime
	s.mcpRuntime = nil
	s.changedLocked()
	s.mu.Unlock()
	closeMCPRuntime(runtime)
	return nil
}

func (s *Service) closeMCP() {
	_ = s.acquireMCP(context.Background())
	defer s.releaseMCP()
	s.mu.Lock()
	runtime := s.mcpRuntime
	s.mcpRuntime = nil
	s.mu.Unlock()
	closeMCPRuntime(runtime)
}

func closeMCPRuntime(runtime *codingagent.MCPRuntime) {
	if runtime != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		runtime.MarkClosed()
		runtime.Close(ctx)
	}
}

func (s *Service) acquireMCP(ctx context.Context) error {
	select {
	case s.mcpGate <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Service) releaseMCP() { <-s.mcpGate }

func (s *Service) redactMCPLocked(text string) string {
	text = redact(text, s.config.APIKey)
	for _, config := range s.mcpConfigs {
		text = redact(text, config.BearerToken)
		for _, value := range config.Env {
			text = redact(text, value)
		}
	}
	return text
}

func (s *Service) mcpDefinitions() []codingagent.ToolDefinition {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.mcpRuntime == nil {
		return nil
	}
	runtime := s.mcpRuntime
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
					if s.mcpRuntime == runtime {
						s.mcpRuntime = nil
						s.changedLocked()
					}
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
				message := s.redactMCPLocked(err.Error())
				s.mu.Unlock()
				return result, errors.New(message)
			}
			return result, nil
		}
	}
	return definitions
}
