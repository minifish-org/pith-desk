package desk

import (
	"context"
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
	OAuth            bool              `json:"oauth"`
	OAuthClientID    string            `json:"oauthClientId,omitempty"`
	OAuthScope       string            `json:"oauthScope,omitempty"`
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
	OAuth          bool     `json:"oauth"`
	SignedIn       bool     `json:"signedIn"`
	OAuthClientID  string   `json:"oauthClientId,omitempty"`
	OAuthScope     string   `json:"oauthScope,omitempty"`
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
	OAuth         bool              `json:"oauth"`
	OAuthClientID string            `json:"oauthClientId,omitempty"`
	OAuthScope    string            `json:"oauthScope,omitempty"`
	Name          string            `json:"name"`
	Type          string            `json:"type"`
	URL           string            `json:"url,omitempty"`
	Command       string            `json:"command,omitempty"`
	Args          []string          `json:"args"`
	BearerToken   string            `json:"bearerToken,omitempty"`
	Enabled       bool              `json:"enabled"`
	Env           map[string]string `json:"env,omitempty"`
}

func (s *Service) ListMCP() []MCPServerView {
	s.mu.Lock()
	defer s.mu.Unlock()
	statuses := map[string]codingagent.MCPServerStatus{}
	runtime := s.connections.mcpRuntime
	if s.active.Running && s.active.mcpRuntime != nil {
		runtime = s.active.mcpRuntime
	}
	if runtime != nil {
		for _, status := range runtime.Statuses() {
			statuses[status.Name] = status
		}
	}
	views := make([]MCPServerView, 0, len(s.connections.mcpConfigs))
	for _, config := range s.connections.mcpConfigs {
		auth, _ := s.mcpOAuthStore(config).Load()
		view := MCPServerView{OAuth: config.OAuth, OAuthClientID: config.OAuthClientID, OAuthScope: config.OAuthScope, SignedIn: auth != nil && auth.Tokens != nil, Name: config.Name, Type: config.Type, URL: config.URL, Command: config.Command,
			Args: append([]string{}, config.Args...), Enabled: config.Enabled, HasBearerToken: config.BearerToken != "", Status: "disconnected"}
		view.EnvKeys = []string{}
		for key := range config.Env {
			view.EnvKeys = append(view.EnvKeys, key)
		}
		sort.Strings(view.EnvKeys)
		if config.Enabled && s.connections.mcpConnecting {
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
	next := savedMCP{OAuth: input.OAuth && input.Type == "http", OAuthClientID: strings.TrimSpace(input.OAuthClientID), OAuthScope: strings.TrimSpace(input.OAuthScope), Name: strings.TrimSpace(input.Name), Type: strings.TrimSpace(input.Type),
		URL: strings.TrimSpace(input.URL), Command: strings.TrimSpace(input.Command), Args: append([]string{}, input.Args...), Enabled: input.Enabled, Env: map[string]string{}}
	if next.Type == "" {
		next.Type = "stdio"
	}
	index := -1
	for i, existing := range s.connections.mcpConfigs {
		if existing.Name == next.Name {
			index = i
			if existing.Type == next.Type && existing.URL == next.URL {
				next.BearerToken = existing.BearerToken
			}
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
	if err := s.connections.prepareMCPAuthChange(s.files); err != nil {
		s.mu.Unlock()
		return err
	}
	var pending *pendingMCPAuth
	if index >= 0 {
		previous := s.connections.mcpConfigs[index]
		if previous.URL != next.URL || previous.OAuth != next.OAuth || previous.OAuthClientID != next.OAuthClientID || previous.OAuthScope != next.OAuthScope {
			var err error
			pending, err = s.connections.stageMCPAuth(previous, s.files)
			if err != nil {
				s.mu.Unlock()
				return err
			}
		}
	}
	configs := append([]savedMCP{}, s.connections.mcpConfigs...)
	if index < 0 {
		configs = append(configs, next)
	} else {
		configs[index] = next
	}
	if err := s.files.WriteJSON(filepath.Join(s.dataDir, "mcp.json"), configs); err != nil {
		rollbackErr := pending.finish(false)
		s.mu.Unlock()
		return errors.Join(err, rollbackErr)
	}
	// Config is the commit point; an old OAuth backup is never a credential
	// source for the new config, even if backup cleanup needs a restart.
	cleanupErr := pending.finish(true)
	old := s.connections.commitMCPConfigs(configs)
	s.changedLocked()
	s.mu.Unlock()
	closeMCPRuntime(old)
	if cleanupErr != nil {
		return fmt.Errorf("MCP configuration saved, but old OAuth cleanup failed: %w", cleanupErr)
	}
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
	if err := s.connections.prepareMCPAuthChange(s.files); err != nil {
		s.mu.Unlock()
		return err
	}
	configs := make([]savedMCP, 0, len(s.connections.mcpConfigs))
	var pending *pendingMCPAuth
	found := false
	for _, config := range s.connections.mcpConfigs {
		if config.Name == name {
			found = true
			var err error
			pending, err = s.connections.stageMCPAuth(config, s.files)
			if err != nil {
				s.mu.Unlock()
				return err
			}
		} else {
			configs = append(configs, config)
		}
	}
	if !found {
		s.mu.Unlock()
		return errors.New("MCP server not found")
	}
	if err := s.files.WriteJSON(filepath.Join(s.dataDir, "mcp.json"), configs); err != nil {
		rollbackErr := pending.finish(false)
		s.mu.Unlock()
		return errors.Join(err, rollbackErr)
	}
	// A restart restores staged credentials only while their configuration
	// remains committed; a successful deletion must never resurrect a login.
	cleanupErr := pending.finish(true)
	old := s.connections.commitMCPConfigs(configs)
	s.changedLocked()
	s.mu.Unlock()
	closeMCPRuntime(old)
	if cleanupErr != nil {
		return fmt.Errorf("MCP connection removed, but old OAuth cleanup failed: %w", cleanupErr)
	}
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
		Command: config.Command, Args: append([]string{}, config.Args...), Enabled: &enabled, Exposure: codingagent.MCPExposureDeferred}
	result.Env = map[string]string{}
	for key, value := range config.Env {
		result.Env[key] = value
	}
	if config.BearerToken != "" {
		result.Headers = map[string]string{"Authorization": "Bearer " + config.BearerToken}
	}
	return result
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

func (s *Service) closeMCP() {
	_ = s.acquireMCP(context.Background())
	defer s.releaseMCP()
	s.mu.Lock()
	runtime := s.connections.takeMCPPreview()
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
	case s.connections.mcpGate <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Service) releaseMCP() { <-s.connections.mcpGate }

func (s *Service) redactMCPLocked(text string) string { return s.connections.redactMCP(text, s.files) }

func (s *Service) loadMCPRuntime(ctx context.Context, configs []codingagent.MCPServerConfig) (*codingagent.MCPRuntime, []codingagent.MCPDiagnostic) {
	return s.connections.loadMCPRuntime(ctx, configs, s.files)
}
