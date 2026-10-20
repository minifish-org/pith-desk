package desk

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"path/filepath"

	authtypes "github.com/minifish-org/pith/packages/ai/auth/types"
)

// This allowlist reflects the pinned SDK flows, not the presence of an OAuth
// button. New flows need a remote interaction audit before being advertised.
func ServerOAuthSupported(provider string) bool {
	switch provider {
	case "anthropic", "openai-codex", "openai-chatgpt", "github-copilot", "kimi-coding", "meta", "xai", "radius", "openrouter":
		return true
	default:
		return false
	}
}

func (s *Service) StartServerOAuth(providerID string) error {
	if !ServerOAuthSupported(providerID) {
		return errors.New("This provider's sign-in is not available remotely. Configure an API key instead")
	}
	runtime, err := modelRuntime()
	if err != nil {
		return err
	}
	provider := runtime.GetProvider(providerID)
	if provider == nil || provider.Auth().OAuth == nil {
		return errors.New("This provider does not support SDK OAuth login")
	}
	var deviceID string
	if providerID == "openai-chatgpt" {
		deviceID, err = s.oauthDeviceID()
		if err != nil {
			return err
		}
	}
	return s.startOAuth(providerID, serverOAuthLogin(providerID, provider.Auth().OAuth, deviceID))
}

func serverOAuthLogin(provider string, auth *authtypes.OAuthAuth, deviceID string) oauthLogin {
	return func(ctx context.Context, interaction authtypes.ProviderAuthInteraction) (*authtypes.OAuthCredential, error) {
		// Select only the SDK's headless method. Other prompts (enterprise host,
		// authorization code or full redirect URL) still go to the user.
		method := map[string]string{"anthropic": "copy_code", "openai-codex": "device_code", "radius": "device-code"}[provider]
		remote := authtypes.NewInteraction(interaction.Signal(), func(ctx context.Context, prompt authtypes.AuthPrompt) (string, error) {
			if method != "" && prompt.Type == authtypes.AuthPromptSelect {
				for _, option := range prompt.Options {
					if option.ID == method {
						return method, nil
					}
				}
				return "", errors.New("The SDK no longer offers this provider's remote sign-in method")
			}
			return interaction.Prompt(ctx, prompt)
		}, interaction.Notify)
		if auth.LoginWithOptions != nil {
			return auth.LoginWithOptions(ctx, remote, &authtypes.LoginOptions{GetDeviceID: func() string { return deviceID }})
		}
		return auth.Login(ctx, remote)
	}
}

// ChatGPT binds authorization to an installation UUID. Keep it in the private
// profile, stable across reconnects and restarts. The SDK includes this public
// installation identifier in the authorization URL; it is not an access token.
func (s *Service) oauthDeviceID() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.availableLocked(); err != nil {
		return "", err
	}
	path := filepath.Join(s.dataDir, "oauth-device.json")
	var saved struct {
		ID string `json:"id"`
	}
	if err := s.files.ReadJSON(path, &saved); err != nil {
		return "", err
	}
	if saved.ID != "" {
		return saved.ID, nil
	}
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "", err
	}
	id[6], id[8] = (id[6]&0x0f)|0x40, (id[8]&0x3f)|0x80
	saved.ID = fmt.Sprintf("%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:])
	if err := s.files.WriteJSON(path, saved); err != nil {
		return "", err
	}
	return saved.ID, nil
}
