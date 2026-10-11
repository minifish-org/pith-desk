package desk

import (
	"context"
	"errors"
	"net/url"
	"path/filepath"

	authtypes "github.com/minifish-org/pith/packages/ai/auth/types"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
)

type LoginStatus struct {
	ID         string        `json:"id"`
	Provider   string        `json:"provider"`
	Phase      string        `json:"phase"`
	Message    string        `json:"message"`
	URL        string        `json:"url,omitempty"`
	Code       string        `json:"code,omitempty"`
	Prompt     string        `json:"prompt,omitempty"`
	PromptType string        `json:"promptType,omitempty"`
	Options    []LoginOption `json:"options,omitempty"`
}
type LoginOption struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

type oauthLogin func(context.Context, authtypes.ProviderAuthInteraction) (*authtypes.OAuthCredential, error)

func (s *Service) StartOAuth(providerID string) error { return s.startOAuth(providerID, nil) }

func (s *Service) startOAuth(providerID string, login oauthLogin) error {
	return s.connections.startOAuth(providerID, login, s.idleLocked, s.saveConfigLocked, s.changedLocked)
}

func (c *Connections) startOAuth(providerID string, login oauthLogin, canStart func() error, save func(savedConfig) error, changed func()) error {
	c.mu.Lock()
	if err := canStart(); err != nil {
		c.mu.Unlock()
		return err
	}
	runtime, err := runtimeForConfig(c.config)
	if err != nil {
		c.mu.Unlock()
		return err
	}
	provider := runtime.GetProvider(providerID)
	if provider == nil || provider.Auth().OAuth == nil {
		c.mu.Unlock()
		return errors.New("This provider does not support SDK OAuth login")
	}
	preferred, err := preferredProviderModel(providerID, c.config)
	if err != nil {
		c.mu.Unlock()
		return err
	}
	base := provider.BaseURL()
	if base == "" {
		base = preferred.BaseUrl
	}
	connection := c.config.Connections[providerID]
	if connection.BaseURL != "" && connection.BaseURL != base && connection.BaseURL != preferred.BaseUrl {
		c.mu.Unlock()
		return errors.New("Restore this provider's official endpoint before OAuth login")
	}
	ctx, cancel := context.WithCancel(context.Background())
	c.loginCancel, c.loginDone = cancel, make(chan struct{})
	c.loginAnswer = make(chan string, 1)
	c.Login = &LoginStatus{ID: newID(), Provider: providerID, Phase: "working", Message: "Starting sign-in…"}
	id, done := c.Login.ID, c.loginDone
	authPath := c.config.AuthPath
	changed()
	c.mu.Unlock()
	interaction := authtypes.NewInteraction(ctx, func(promptCtx context.Context, prompt authtypes.AuthPrompt) (string, error) {
		c.mu.Lock()
		c.Login.Prompt, c.Login.PromptType = prompt.Message, prompt.Type
		c.Login.Options = nil
		for _, option := range prompt.Options {
			c.Login.Options = append(c.Login.Options, LoginOption{option.ID, option.Label})
		}
		c.Login.Phase = "prompt"
		changed()
		c.mu.Unlock()
		select {
		case answer := <-c.loginAnswer:
			return answer, nil
		case <-promptCtx.Done():
			return "", promptCtx.Err()
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}, func(event authtypes.AuthEvent) {
		c.mu.Lock()
		defer c.mu.Unlock()
		if event.Message != nil {
			c.Login.Message = *event.Message
		}
		if event.Instructions != nil {
			c.Login.Message = *event.Instructions
		}
		if event.URL != nil {
			c.Login.URL = safeLoginURL(*event.URL)
		}
		if event.VerificationURI != nil {
			c.Login.URL = safeLoginURL(*event.VerificationURI)
		}
		if event.UserCode != nil {
			c.Login.Code = *event.UserCode
		}
		changed()
	})
	go func() {
		defer close(done)
		defer cancel()
		if login == nil {
			login = provider.Auth().OAuth.Login
		}
		credential, loginErr := login(ctx, interaction)
		if loginErr == nil && ctx.Err() == nil {
			_, loginErr = codingagent.CreateAuthStorage(authPath).Modify(ctx, providerID, func(authtypes.Credential) (authtypes.Credential, error) { return credential, nil }, nil)
		}
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.Login == nil || c.Login.ID != id {
			return
		}
		if loginErr != nil || ctx.Err() != nil {
			c.Login.Phase, c.Login.Message = "error", "Sign-in did not finish. Retry or use an API key."
		} else {
			next := normalizedConfig(c.config)
			connection = next.Connections[providerID]
			connection.UseOAuth, connection.BaseURL, connection.Model = true, base, preferred.Id
			next.Connections[providerID] = connection
			if next.Provider == providerID {
				next.BaseURL = base
				next.APIKey = ""
			}
			if loginErr = save(next); loginErr != nil {
				c.Login.Phase, c.Login.Message = "error", "Sign-in succeeded but the connection could not be saved."
			} else {
				c.Login.Phase, c.Login.Message = "complete", "Signed in. Choose this provider's model beside the message box."
			}
		}
		c.Login.URL, c.Login.Code, c.Login.Prompt = "", "", ""
		c.loginCancel = nil
		changed()
	}()
	return nil
}

func safeLoginURL(value string) string {
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
		return ""
	}
	return value
}

func (s *Service) AnswerOAuth(id, answer string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.connections.Login == nil || s.connections.Login.ID != id || s.connections.Login.Phase != "prompt" {
		return errors.New("This login prompt is no longer active")
	}
	select {
	case s.connections.loginAnswer <- answer:
		s.connections.Login.Prompt = ""
		s.connections.Login.Phase = "working"
		s.changedLocked()
		return nil
	default:
		return errors.New("A login answer is already pending")
	}
}

func (s *Service) CancelOAuth() {
	s.mu.Lock()
	cancel := s.connections.loginCancel
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (s *Service) LogoutOAuth(provider string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.idleLocked(); err != nil {
		return err
	}
	if err := codingagent.CreateAuthStorage(filepath.Join(s.dataDir, "auth.json")).Delete(context.Background(), provider, nil); err != nil {
		return err
	}
	next := normalizedConfig(s.connections.config)
	connection := next.Connections[provider]
	connection.UseOAuth = false
	next.Connections[provider] = connection
	return s.saveConfigLocked(next)
}
