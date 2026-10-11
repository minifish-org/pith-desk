package desk

import (
	"context"
	"github.com/minifish-org/pith-desk/internal/localstore"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
	"github.com/minifish-org/pith/packages/mcp"
)

func (c *Connections) redactMCP(text string, files localstore.Store) string {
	text = redact(text, c.config.APIKey)
	for _, config := range c.mcpConfigs {
		text = redact(text, config.BearerToken)
		if state, err := c.mcpOAuthStore(config, files).Load(); err == nil && state != nil {
			if state.Tokens != nil {
				text = redact(text, state.Tokens.AccessToken)
				text = redact(text, state.Tokens.RefreshToken)
			}
			if state.ClientInformation != nil {
				text = redact(text, state.ClientInformation.ClientSecret)
			}
		}
		for _, value := range config.Env {
			text = redact(text, value)
		}
	}
	return text
}

// Each execution gets its own transports. Canceling one SDK tool must never
// close the MCP connection serving another workspace.
func (c *Connections) loadMCPRuntime(ctx context.Context, configs []codingagent.MCPServerConfig, files localstore.Store) (*codingagent.MCPRuntime, []codingagent.MCPDiagnostic) {
	runtime := codingagent.NewMCPRuntime(codingagent.MCPRuntimeOptions{ClientName: "pith-desk", ClientVersion: "1",
		TransportFactory: func(config codingagent.MCPServerConfig) (mcp.Transport, error) {
			if config.Type != "http" {
				return safeMCPTransport(config)
			}
			var saved savedMCP
			c.mu.Lock()
			for _, candidate := range c.mcpConfigs {
				if candidate.Name == config.Name {
					saved = candidate
				}
			}
			if !saved.OAuth {
				c.mu.Unlock()
				return safeMCPTransport(config)
			}
			store := c.mcpOAuthStore(saved, files)
			provider := c.mcpTokens[store.path]
			if provider == nil {
				provider = newMCPTokenProvider(saved, store)
				c.mcpTokens[store.path] = provider
			}
			c.mu.Unlock()
			return mcp.NewStreamableHTTPTransport(config.URL, &mcp.HTTPOptions{AuthProvider: provider}), nil
		},
		OnError: func(_ string, _ error) {
			// Pith's runtime supplies connection status diagnostics. Avoid logging
			// raw transport errors, which may contain echoed HTTP credentials.
		},
	})
	loadFinished, watcherFinished := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(watcherFinished)
		select {
		case <-ctx.Done():
			// This SDK's HTTP Send uses the transport lifetime context. Close
			// cancels it even when initialization is awaiting response headers.
			closeMCPRuntime(runtime)
		case <-loadFinished:
		}
	}()
	diagnostics := runtime.Load(ctx, configs)
	close(loadFinished)
	<-watcherFinished
	return runtime, diagnostics
}
