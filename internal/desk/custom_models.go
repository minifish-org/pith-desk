package desk

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"

	"github.com/minifish-org/pith/packages/ai/api"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
)

// Custom connections use the SDK's provider registration and native adapters.
// Their IDs are independent of built-ins, even when they speak the same API.
type CustomConnectionInput struct {
	ID      string                        `json:"id"`
	Name    string                        `json:"name"`
	BaseURL string                        `json:"baseUrl"`
	API     aitypes.Api                   `json:"api"`
	APIKey  string                        `json:"apiKey"`
	Models  []codingagent.ModelsJsonModel `json:"models"`
}

func runtimeForConfig(config savedConfig) (*codingagent.ModelRuntime, error) {
	custom := false
	for _, connection := range config.Connections {
		custom = custom || connection.API != ""
	}
	if !custom && config.AuthPath == "" {
		return modelRuntime()
	}
	runtime, err := codingagent.CreateModelRuntime(codingagent.CreateModelRuntimeOptions{AuthPath: config.AuthPath})
	if err != nil {
		return nil, err
	}
	for id, connection := range config.Connections {
		if connection.API == "" {
			continue
		}
		err = runtime.RegisterProvider(id, codingagent.ProviderConfigInput{
			StreamSimple: protocolStream(connection.API),
			Name:         connection.Name, API: connection.API, BaseURL: connection.BaseURL,
			APIKey: "desk-managed", AuthHeader: true, Models: connection.Models,
		})
		if err != nil {
			return nil, fmt.Errorf("Register connection %s: %w", id, err)
		}
	}
	return runtime, nil
}

func (s *Service) SaveCustomConnection(input CustomConnectionInput) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.idleLocked(); err != nil {
		return err
	}
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" || len(input.Models) == 0 {
		return errors.New("Enter a connection name and at least one model")
	}
	if protocolStream(input.API) == nil {
		return errors.New("Choose a supported native API protocol")
	}
	if input.ID == "" {
		input.ID = "custom-" + newID()
	}
	if !strings.HasPrefix(input.ID, "custom-") {
		return errors.New("Custom connections cannot replace built-in providers")
	}
	seen := map[string]bool{}
	for _, model := range input.Models {
		if strings.TrimSpace(model.ID) == "" || seen[model.ID] {
			return errors.New("Model IDs must be nonempty and unique")
		}
		seen[model.ID] = true
		if model.ContextWindow == nil || *model.ContextWindow <= 0 || model.MaxTokens == nil || *model.MaxTokens <= 0 || *model.MaxTokens > *model.ContextWindow {
			return errors.New("Set positive context and output limits for every custom model")
		}
		if model.API != "" && model.API != input.API || model.BaseURL != "" {
			return errors.New("Models must use their connection's protocol and endpoint")
		}
		if model.Cost != nil {
			for _, price := range []float64{model.Cost.Input, model.Cost.Output, model.Cost.CacheRead, model.Cost.CacheWrite} {
				if math.IsNaN(price) || math.IsInf(price, 0) || price < 0 {
					return errors.New("Prices must be finite, nonnegative USD amounts per million tokens")
				}
			}
		}
	}
	current := normalizedConfig(s.config)
	previous := current.Connections[input.ID]
	key := strings.TrimSpace(input.APIKey)
	if key == "" && previous.BaseURL == strings.TrimRight(strings.TrimSpace(input.BaseURL), "/") && previous.API == input.API {
		key = previous.APIKey
	}
	model, thinking := input.Models[0].ID, "off"
	if seen[previous.Model] {
		model, thinking = previous.Model, previous.ThinkingLevel
	}
	current.Connections[input.ID] = savedConnection{Name: input.Name, API: input.API, Models: input.Models, BaseURL: input.BaseURL, APIKey: key, Model: model, ThinkingLevel: thinking}
	in := ConfigInput{Provider: input.ID, BaseURL: input.BaseURL, APIKey: key, Model: model, ThinkingLevel: thinking}
	candidate, err := validatedConfig(in, current)
	if err != nil {
		return err
	}
	next := s.config
	next.Connections = candidate.Connections
	if next.Provider == input.ID {
		next = candidate
	}
	return s.saveConfigLocked(next)
}

func (s *Service) RemoveModelConnection(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.idleLocked(); err != nil {
		return err
	}
	if id == s.config.Provider {
		return errors.New("Select another model before removing its connection")
	}
	next := normalizedConfig(s.config)
	delete(next.Connections, id)
	return s.saveConfigLocked(next)
}

func streamForConfig(ctx context.Context, config savedConfig) (func(*aitypes.Model, *aitypes.TranscriptContext, *aitypes.SimpleStreamOptions) *aitypes.AssistantMessageEventStream, error) {
	return streamForConfigWithAuthGate(ctx, config, nil)
}

// Serialize credential refresh against the shared auth file, releasing the
// gate before streaming. Independent model requests continue concurrently.
func streamForConfigWithAuthGate(ctx context.Context, config savedConfig, gate chan struct{}) (func(*aitypes.Model, *aitypes.TranscriptContext, *aitypes.SimpleStreamOptions) *aitypes.AssistantMessageEventStream, error) {
	runtime, err := runtimeForConfig(config)
	if err != nil {
		return nil, err
	}
	provider := runtime.GetProvider(config.Provider)
	if provider == nil {
		return nil, errors.New("The selected provider is unavailable")
	}
	return func(model *aitypes.Model, transcript *aitypes.TranscriptContext, options *aitypes.SimpleStreamOptions) *aitypes.AssistantMessageEventStream {
		request := aitypes.SimpleStreamOptions{}
		if options != nil {
			request = *options
		}
		// The native adapters require a nonempty key. Local compatible servers
		// that do not authenticate accept this explicit, non-secret placeholder.
		if config.Connections[config.Provider].API != "" && config.APIKey == "" {
			unused := "unused"
			request.APIKey = &unused
		}
		if config.Connections[config.Provider].UseOAuth {
			if gate != nil {
				select {
				case gate <- struct{}{}:
				case <-ctx.Done():
					return failedModelStream("Model authentication was canceled")
				}
			}
			auth, authErr := runtime.GetAuth(ctx, *model)
			if gate != nil {
				<-gate
			}
			if authErr != nil || auth == nil {
				return failedModelStream("Sign in again: model authentication failed")
			}
			request.APIKey, request.Headers, request.Env = auth.Auth.APIKey, auth.Auth.Headers, auth.Env
			if auth.Auth.BaseURL != nil {
				copy := *model
				copy.BaseUrl = *auth.Auth.BaseURL
				model = &copy
			}
		}
		return provider.StreamSimple(*model, transcript, &request)
	}, nil
}

func failedModelStream(message string) *aitypes.AssistantMessageEventStream {
	stream := aitypes.NewAssistantMessageEventStream()
	stream.Push(aitypes.NewErrorEvent(aitypes.StopReasonError, aitypes.AssistantMessage{Role: aitypes.AssistantMessageRole, StopReason: aitypes.StopReasonError, ErrorMessage: &message}))
	return stream
}

// Return editable metadata only. Credentials never enter the UI.
func (s *Service) CustomConnection(id string) (CustomConnectionInput, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	connection, ok := s.config.Connections[id]
	if !ok || connection.API == "" {
		return CustomConnectionInput{}, errors.New("Custom connection not found")
	}
	return CustomConnectionInput{ID: id, Name: connection.Name, API: connection.API, BaseURL: connection.BaseURL, Models: connection.Models}, nil
}

func protocolStream(protocol aitypes.Api) func(*aitypes.Model, *aitypes.TranscriptContext, *aitypes.SimpleStreamOptions) *aitypes.AssistantMessageEventStream {
	var native aitypes.ProviderStreams
	switch protocol {
	case aitypes.ApiOpenAICompletions:
		native = api.OpenAICompletionsApi()
	case aitypes.ApiOpenAIResponses:
		native = api.OpenAIResponsesApi()
	case aitypes.ApiAnthropicMessages:
		native = api.AnthropicMessagesApi()
	case aitypes.ApiGoogleGenerativeAI:
		native = api.GoogleGenerativeAIApi()
	case aitypes.ApiMistralConversations:
		native = api.MistralConversationsApi()
	default:
		return nil
	}
	return native.StreamSimple
}
