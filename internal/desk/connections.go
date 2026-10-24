package desk

import (
	"context"
	"fmt"
	"path/filepath"
	"sync"

	"github.com/minifish-org/pith-desk/internal/localstore"
	agenttypes "github.com/minifish-org/pith/packages/agent/types"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
)

// Connections owns persistent connection configuration and global auth/probe
// coordination. Its preview runtime is separate from each task's transports.
// The shared application mutex retains the existing synchronization order.
type Connections struct {
	connectionState
	config           savedConfig
	dataDir          string
	mu               *sync.Mutex
	loginCancel      context.CancelFunc
	loginDone        chan struct{}
	loginAnswer      chan string
	probeCancel      context.CancelFunc
	probeDone        chan struct{}
	modelAuthGate    chan struct{}
	mcpGate          chan struct{}
	mcpConfigs       []savedMCP
	mcpRuntime       *codingagent.MCPRuntime
	mcpConnecting    bool
	mcpConnectCancel context.CancelFunc
	mcpTokens        map[string]*mcpTokenProvider
}

func newConnections(dataDir string, mu *sync.Mutex) Connections {
	return Connections{dataDir: dataDir, mu: mu, modelAuthGate: make(chan struct{}, 1), mcpGate: make(chan struct{}, 1), mcpTokens: map[string]*mcpTokenProvider{}, config: savedConfig{BaseURL: "https://api.deepseek.com/v1", Model: "deepseek-flash", Appearance: AppearanceSystem}}
}

func (c *Connections) restore(files localstore.Store) error {
	if err := files.ReadJSON(filepath.Join(c.dataDir, "settings.json"), &c.config); err != nil {
		return fmt.Errorf("load settings: %w", err)
	}
	c.config.AuthPath = filepath.Join(c.dataDir, "auth.json")
	c.config.Appearance = normalizedAppearance(c.config.Appearance)
	c.config = normalizedConfig(c.config)
	if err := files.ReadJSON(filepath.Join(c.dataDir, "mcp.json"), &c.mcpConfigs); err != nil {
		return fmt.Errorf("load MCP settings: %w", err)
	}
	if err := c.recoverMCPAuth(files); err != nil {
		return fmt.Errorf("recover MCP OAuth configuration commit: %w", err)
	}
	return nil
}

func (c *Connections) commitConfig(next savedConfig) { c.config = next; c.refreshSettings() }
func (c *Connections) taskConfig() savedConfig       { return normalizedConfig(c.config) }
func (c *Connections) stream(ctx context.Context, config savedConfig) (agenttypes.StreamFn, error) {
	return streamForConfigWithAuthGate(ctx, config, c.modelAuthGate)
}

// Settings and login are projected from their connection owner.
type connectionState struct {
	Settings Settings
	Login    *LoginStatus
}

func (c *Connections) refreshSettings() {
	model, _ := resolveConfiguredModel(c.config)
	name := c.config.Model
	if model != nil {
		name = model.Name
	}
	hasConnections := false
	for _, connection := range c.config.Connections {
		hasConnections = hasConnections || connectionReady(connection)
	}
	c.Settings = Settings{HasConnections: hasConnections, Provider: c.config.Provider, ModelName: name, ThinkingLevel: c.config.ThinkingLevel, ThinkingLevels: thinkingLevels(model), BaseURL: c.config.BaseURL, Model: c.config.Model, HasAPIKey: connectionReady(c.config.Connections[c.config.Provider]), Appearance: c.config.Appearance, NavigationWidth: c.config.NavigationWidth, ToolsWidth: c.config.ToolsWidth, ImageUploadLimit: MaxImageUploadBytes, SupportsImages: model != nil && model.SupportsImageInput()}
}

func (c *Connections) beginProbe(cancel context.CancelFunc, done chan struct{}) {
	c.probeCancel, c.probeDone = cancel, done
}
func (c *Connections) endProbe() { c.probeCancel, c.probeDone = nil, nil }

// These are state transitions only. Callers retain the original commit point,
// shared mutex, notifications and close-outside-the-lock resource ordering.
func (c *Connections) commitMCPConfigs(configs []savedMCP) *codingagent.MCPRuntime {
	old := c.takeMCPPreview()
	c.mcpConfigs = configs
	c.mcpTokens = map[string]*mcpTokenProvider{}
	return old
}
func (c *Connections) beginMCPPreview(cancel context.CancelFunc) *codingagent.MCPRuntime {
	c.mcpConnectCancel, c.mcpConnecting = cancel, true
	return c.takeMCPPreview()
}
func (c *Connections) endMCPPreview()                                { c.mcpConnectCancel, c.mcpConnecting = nil, false }
func (c *Connections) setMCPPreview(runtime *codingagent.MCPRuntime) { c.mcpRuntime = runtime }
func (c *Connections) takeMCPPreview() *codingagent.MCPRuntime {
	runtime := c.mcpRuntime
	c.mcpRuntime = nil
	return runtime
}
