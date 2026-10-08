package desk

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"sync"

	"github.com/minifish-org/pith/packages/ai"
	"github.com/minifish-org/pith/packages/ai/catalog"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
)

// The SDK owns the catalog and all native protocol adapters. Desk only exposes
// safe selection metadata and keeps credentials scoped to a provider/endpoint.
var sdkModels struct {
	sync.Once
	runtime *codingagent.ModelRuntime
	err     error
}

func modelRuntime() (*codingagent.ModelRuntime, error) {
	sdkModels.Do(func() {
		sdkModels.runtime, sdkModels.err = createModelRuntime("")
	})
	return sdkModels.runtime, sdkModels.err
}

// The SDK's OpenAI provider constructors still expose the legacy catalog.
// Use its newer release records while retaining native streams and auth.
type releaseCatalogProvider struct {
	ai.Provider
	models []aitypes.Model
}

func (p releaseCatalogProvider) GetModels() []aitypes.Model {
	return append([]aitypes.Model(nil), p.models...)
}

func createModelRuntime(authPath string) (*codingagent.ModelRuntime, error) {
	runtime, err := codingagent.CreateModelRuntime(codingagent.CreateModelRuntimeOptions{AuthPath: authPath})
	if err != nil {
		return nil, err
	}
	for _, id := range []string{"openai", "openai-codex"} {
		models := []aitypes.Model{}
		for _, record := range catalog.V1Models(id, "chat") {
			var model aitypes.Model
			if err := json.Unmarshal(record, &model); err != nil {
				return nil, fmt.Errorf("Read Pith release catalog for %s: %w", id, err)
			}
			models = append(models, model)
		}
		if len(models) == 0 {
			return nil, fmt.Errorf("Pith release catalog for %s is empty", id)
		}
		provider := runtime.GetProvider(id)
		if provider == nil {
			return nil, fmt.Errorf("Pith provider %s is unavailable", id)
		}
		runtime.RegisterNativeProvider(releaseCatalogProvider{Provider: provider, models: models})
		if message := runtime.GetError(); message != "" {
			return nil, errors.New(message)
		}
	}
	return runtime, nil
}

type ProviderChoice struct {
	OAuth           bool   `json:"oauth"`
	APIKeySupported bool   `json:"apiKeySupported"`
	SignedIn        bool   `json:"signedIn"`
	Custom          bool   `json:"custom"`
	ID              string `json:"id"`
	Name            string `json:"name"`
	BaseURL         string `json:"baseUrl"`
	HasAPIKey       bool   `json:"hasApiKey"`
	HasSavedKey     bool   `json:"hasSavedKey"`
	Model           string `json:"model,omitempty"`
	ThinkingLevel   string `json:"thinkingLevel,omitempty"`
}

type ModelChoice struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	Provider       string   `json:"provider"`
	API            string   `json:"api"`
	SupportsImages bool     `json:"supportsImages"`
	ContextWindow  float64  `json:"contextWindow"`
	MaxTokens      float64  `json:"maxTokens"`
	ThinkingLevels []string `json:"thinkingLevels"`
}

type ModelCatalog struct {
	Providers []ProviderChoice `json:"providers"`
	Models    []ModelChoice    `json:"models"`
	Source    string           `json:"source"`
}

// Provider connections are independent of the model used by a conversation.
type ProviderConnectionInput struct {
	Provider    string `json:"provider"`
	BaseURL     string `json:"baseUrl"`
	APIKey      string `json:"apiKey,omitempty"`
	ClearAPIKey bool   `json:"clearApiKey,omitempty"`
}

func preferredProviderModel(provider string, current savedConfig) (*aitypes.Model, error) {
	runtime, err := runtimeForConfig(current)
	if err != nil {
		return nil, err
	}
	candidate := current.Connections[provider].Model
	if candidate == "" {
		candidate = codingagent.DefaultModelPerProvider[provider]
	}
	if model := runtime.GetModel(provider, candidate); model != nil && supportedDesktopModel(*model) {
		return model, nil
	}
	models := runtime.GetModels()
	sort.Slice(models, func(i, j int) bool { return models[i].Id < models[j].Id })
	for _, model := range models {
		if string(model.Provider) == provider && supportedDesktopModel(model) {
			return &model, nil
		}
	}
	return nil, errors.New("Choose a supported provider from Pith's catalog")
}

func connectionConfigInput(input ProviderConnectionInput, current savedConfig) (ConfigInput, error) {
	provider := strings.TrimSpace(input.Provider)
	if provider == "" {
		return ConfigInput{}, errors.New("Choose a provider first")
	}
	model, err := preferredProviderModel(provider, current)
	if err != nil {
		return ConfigInput{}, err
	}
	base := input.BaseURL
	if strings.TrimSpace(base) == "" {
		base = current.Connections[provider].BaseURL
		if base == "" {
			runtime, err := modelRuntime()
			if err != nil {
				return ConfigInput{}, err
			}
			base = runtime.GetProvider(provider).BaseURL()
			if base == "" {
				base = model.BaseUrl
			}
		}
	}
	level := current.Connections[provider].ThinkingLevel
	if level == "" {
		level = string(codingagent.DefaultThinkingLevel)
	}
	level = string(ai.ClampThinkingLevel(*model, aitypes.ModelThinkingLevel(level)))
	return ConfigInput{Provider: provider, BaseURL: base, Model: model.Id, ThinkingLevel: level, APIKey: input.APIKey, ClearAPIKey: input.ClearAPIKey}, nil
}

// ConfigureProvider saves credentials without selecting another provider/model.
// The active connection's endpoint/key projection is updated immediately.
func (s *Service) ConfigureProvider(input ProviderConnectionInput) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.idleLocked(); err != nil {
		return err
	}
	in, err := connectionConfigInput(input, s.config)
	if err != nil {
		return err
	}
	candidate, err := validatedConfig(in, s.config)
	if err != nil {
		return err
	}
	next := s.config
	next.Connections = candidate.Connections
	if candidate.Provider == next.Provider {
		next.BaseURL, next.APIKey = candidate.BaseURL, candidate.APIKey
	}
	return s.saveConfigLocked(next)
}

func (s *Service) TestProviderConnection(ctx context.Context, input ProviderConnectionInput) (ConnectionTest, error) {
	s.mu.Lock()
	in, err := connectionConfigInput(input, s.config)
	s.mu.Unlock()
	if err != nil {
		return ConnectionTest{}, err
	}
	result, err := s.TestConnection(ctx, in)
	if err == nil && result.OK {
		result.Message = "Streaming and tool calling succeeded using " + in.Model + ". Connection settings have not been saved."
	}
	return result, err
}

type savedConnection struct {
	UseOAuth      bool                          `json:"useOAuth,omitempty"`
	Name          string                        `json:"name,omitempty"`
	API           aitypes.Api                   `json:"api,omitempty"`
	Models        []codingagent.ModelsJsonModel `json:"models,omitempty"`
	BaseURL       string                        `json:"baseUrl"`
	APIKey        string                        `json:"apiKey,omitempty"`
	Model         string                        `json:"model,omitempty"`
	ThinkingLevel string                        `json:"thinkingLevel,omitempty"`
}

func supportedDesktopModel(model aitypes.Model) bool {
	switch model.Api {
	case aitypes.ApiOpenAICompletions, aitypes.ApiOpenAIResponses, aitypes.ApiOpenAICodexResponses,
		aitypes.ApiAnthropicMessages, aitypes.ApiGoogleGenerativeAI, aitypes.ApiMistralConversations:
		return !strings.Contains(model.BaseUrl, "{")
	default:
		return false
	}
}

func thinkingLevels(model *aitypes.Model) []string {
	levels := []string{}
	if model != nil {
		for _, level := range ai.GetSupportedThinkingLevels(*model) {
			levels = append(levels, string(level))
		}
	}
	return levels
}

func describeModel(model aitypes.Model) ModelChoice {
	return ModelChoice{ID: model.Id, Name: model.Name, Provider: string(model.Provider), API: string(model.Api),
		SupportsImages: model.SupportsImageInput(), ContextWindow: model.ContextWindow,
		MaxTokens: model.MaxTokens, ThinkingLevels: thinkingLevels(&model)}
}

func (s *Service) Models(providerID string) (ModelCatalog, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	runtime, err := runtimeForConfig(s.config)
	if err != nil {
		return ModelCatalog{}, err
	}
	result := ModelCatalog{Providers: []ProviderChoice{}, Models: []ModelChoice{}, Source: "Pith SDK catalog"}
	seen := map[string]bool{}
	for _, model := range runtime.GetModels() {
		id := string(model.Provider)
		provider := runtime.GetProvider(id)
		if !supportedDesktopModel(model) || provider == nil || (provider.Auth().APIKey == nil && provider.Auth().OAuth == nil) {
			continue
		}
		if !seen[id] {
			seen[id] = true
			choice := ProviderChoice{OAuth: provider.Auth().OAuth != nil, SignedIn: s.config.Connections[id].UseOAuth, HasSavedKey: s.config.Connections[id].APIKey != "", Custom: s.config.Connections[id].API != "", ID: id, Name: provider.Name(), BaseURL: provider.BaseURL(), Model: codingagent.DefaultModelPerProvider[id]}
			choice.APIKeySupported = provider.Auth().APIKey != nil || choice.Custom
			if preferred := runtime.GetModel(id, choice.Model); preferred != nil {
				choice.ThinkingLevel = string(ai.ClampThinkingLevel(*preferred, aitypes.ModelThinkingLevel(codingagent.DefaultThinkingLevel)))
			}
			if choice.BaseURL == "" {
				choice.BaseURL = model.BaseUrl
			}
			if connection, ok := s.config.Connections[id]; ok {
				choice.BaseURL, choice.HasAPIKey = connection.BaseURL, connectionReady(connection)
				choice.Model, choice.ThinkingLevel = connection.Model, connection.ThinkingLevel
			}
			if id == s.config.Provider {
				choice.BaseURL, choice.HasAPIKey = s.config.BaseURL, connectionReady(s.config.Connections[id])
				choice.Model, choice.ThinkingLevel = s.config.Model, s.config.ThinkingLevel
			}
			result.Providers = append(result.Providers, choice)
		}
		if providerID == "" || providerID == id {
			result.Models = append(result.Models, describeModel(model))
		}
	}
	sort.Slice(result.Providers, func(i, j int) bool { return result.Providers[i].Name < result.Providers[j].Name })
	sort.Slice(result.Models, func(i, j int) bool {
		if result.Models[i].Provider != result.Models[j].Provider {
			return result.Models[i].Provider < result.Models[j].Provider
		}
		return result.Models[i].Name < result.Models[j].Name
	})
	if providerID != "" && !seen[providerID] {
		return ModelCatalog{}, errors.New("Choose a supported provider from Pith's catalog")
	}
	return result, nil
}

// Legacy settings did not name a provider. Resolve the original completions
// selection once, then persist an explicit provider on the next settings save.
func resolveModel(id, baseURL string) (*aitypes.Model, error) {
	runtime, err := modelRuntime()
	if err != nil {
		return nil, err
	}
	if model := runtime.GetModel("deepseek", id); model != nil {
		return resolveConfiguredModel(savedConfig{Provider: "deepseek", Model: id, BaseURL: baseURL})
	}
	models := runtime.GetModels()
	sort.Slice(models, func(i, j int) bool { return models[i].Provider < models[j].Provider })
	for _, model := range models {
		if model.Id == id && model.Api == aitypes.ApiOpenAICompletions && supportedDesktopModel(model) {
			return resolveConfiguredModel(savedConfig{Provider: string(model.Provider), Model: id, BaseURL: baseURL})
		}
	}
	return nil, fmt.Errorf("Model %q is not in Pith's compatible model catalog; choose a provider and model in Settings", id)
}

func resolveConfiguredModel(config savedConfig) (*aitypes.Model, error) {
	if config.Provider == "" {
		return resolveModel(config.Model, config.BaseURL)
	}
	runtime, err := runtimeForConfig(config)
	if err != nil {
		return nil, err
	}
	provider := runtime.GetProvider(config.Provider)
	model := runtime.GetModel(config.Provider, config.Model)
	if provider == nil || (provider.Auth().APIKey == nil && provider.Auth().OAuth == nil) || model == nil || !supportedDesktopModel(*model) {
		return nil, fmt.Errorf("Model %q is not a supported model in Pith's %s catalog", config.Model, config.Provider)
	}
	// ResolveModel clones all SDK capability/compatibility metadata before an
	// endpoint override, so neither the shared catalog nor other runs change.
	model, err = codingagent.ResolveModel(codingagent.ModelOptions{Model: model})
	if err != nil {
		return nil, err
	}
	if config.BaseURL != "" {
		model.BaseUrl = config.BaseURL
	}
	return model, nil
}

func normalizedConfig(current savedConfig) savedConfig {
	if current.Provider == "" {
		if model, err := resolveModel(current.Model, current.BaseURL); err == nil {
			current.Provider = string(model.Provider)
		}
	}
	if model, err := resolveConfiguredModel(current); err == nil && current.ThinkingLevel == "" {
		level := aitypes.ModelThinkingLevel("off")
		if model.Reasoning {
			level = aitypes.ModelThinkingLevel("high")
		}
		current.ThinkingLevel = string(ai.ClampThinkingLevel(*model, level))
	}
	connections := map[string]savedConnection{}
	for id, connection := range current.Connections {
		connections[id] = connection
	}
	current.Connections = connections
	connection := current.Connections[current.Provider]
	connection.BaseURL, connection.APIKey, connection.Model, connection.ThinkingLevel = current.BaseURL, current.APIKey, current.Model, current.ThinkingLevel
	current.Connections[current.Provider] = connection
	return current
}

func validatedConfig(input ConfigInput, current savedConfig) (savedConfig, error) {
	current = normalizedConfig(current)
	provider := strings.TrimSpace(input.Provider)
	if provider == "" {
		provider = current.Provider
	}
	base := strings.TrimRight(strings.TrimSpace(input.BaseURL), "/")
	u, err := url.Parse(base)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return savedConfig{}, errors.New("Enter an HTTP or HTTPS API base URL without credentials, query, or fragment")
	}
	next := savedConfig{AuthPath: current.AuthPath, Provider: provider, BaseURL: base, Model: strings.TrimSpace(input.Model), Appearance: current.Appearance, Connections: map[string]savedConnection{}}
	for id, connection := range current.Connections {
		next.Connections[id] = connection
	}
	connection := current.Connections[provider]
	// Never silently forward a saved key to a different provider or endpoint.
	if connection.BaseURL == base {
		next.APIKey = connection.APIKey
	}
	if input.APIKey != "" {
		connection.UseOAuth = false
		next.APIKey = strings.TrimSpace(input.APIKey)
	}
	if input.ClearAPIKey {
		next.APIKey = ""
	}
	if base != connection.BaseURL {
		connection.UseOAuth = false
		next.Connections[provider] = connection
	}
	model, err := resolveConfiguredModel(next)
	if err != nil {
		return savedConfig{}, err
	}
	level := strings.TrimSpace(input.ThinkingLevel)
	if level == "" {
		level = current.ThinkingLevel
		if provider != current.Provider && connection.ThinkingLevel != "" {
			level = connection.ThinkingLevel
		}
		level = string(ai.ClampThinkingLevel(*model, aitypes.ModelThinkingLevel(level)))
	}
	supported := false
	for _, value := range thinkingLevels(model) {
		if value == level {
			supported = true
		}
	}
	if !supported {
		return savedConfig{}, fmt.Errorf("Thinking level %q is not supported by this model", level)
	}
	next.ThinkingLevel = level
	connection.BaseURL, connection.APIKey, connection.Model, connection.ThinkingLevel = base, next.APIKey, next.Model, level
	next.Connections[provider] = connection
	return next, nil
}

// Probe and compaction use the same Pith provider implementation as the agent.
// Explicit credentials prevent fallback to another app's ambient credentials.
func providerStream(model *aitypes.Model, transcript *aitypes.TranscriptContext, options *aitypes.SimpleStreamOptions) *aitypes.AssistantMessageEventStream {
	runtime, err := modelRuntime()
	if err == nil && model != nil {
		if provider := runtime.GetProvider(string(model.Provider)); provider != nil {
			return provider.StreamSimple(*model, transcript, options)
		}
	}
	stream := aitypes.NewAssistantMessageEventStream()
	message := "The selected Pith provider is unavailable"
	terminal := aitypes.AssistantMessage{Role: aitypes.AssistantMessageRole, StopReason: aitypes.StopReasonError, ErrorMessage: &message}
	stream.Push(aitypes.NewErrorEvent(aitypes.StopReasonError, terminal))
	return stream
}

// SelectModel changes only the active selection, preserving the saved endpoint
// and key for that provider. It cannot race an in-flight agent or probe.
func (s *Service) SelectModel(provider, model, level string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.idleLocked(); err != nil {
		return err
	}
	connection, ok := s.config.Connections[provider]
	if !ok {
		return errors.New("Configure this provider in Settings first")
	}
	next, err := validatedConfig(ConfigInput{Provider: provider, BaseURL: connection.BaseURL, Model: model, ThinkingLevel: level}, s.config)
	if err != nil {
		return err
	}
	return s.saveConfigLocked(next)
}

func connectionReady(connection savedConnection) bool {
	return connection.APIKey != "" || connection.UseOAuth || connection.API != ""
}
