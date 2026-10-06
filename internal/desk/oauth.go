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
	s.mu.Lock()
	if err := s.idleLocked(); err != nil {
		s.mu.Unlock()
		return err
	}
	runtime, err := runtimeForConfig(s.config)
	if err != nil {
		s.mu.Unlock()
		return err
	}
	provider := runtime.GetProvider(providerID)
	if provider == nil || provider.Auth().OAuth == nil {
		s.mu.Unlock()
		return errors.New("This provider does not support SDK OAuth login")
	}
	preferred, err := preferredProviderModel(providerID, s.config)
	if err != nil {
		s.mu.Unlock()
		return err
	}
	base := provider.BaseURL()
	if base == "" {
		base = preferred.BaseUrl
	}
	connection := s.config.Connections[providerID]
	if connection.BaseURL != "" && connection.BaseURL != base && connection.BaseURL != preferred.BaseUrl {
		s.mu.Unlock()
		return errors.New("Restore this provider's official endpoint before OAuth login")
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.loginCancel, s.loginDone = cancel, make(chan struct{})
	s.loginAnswer = make(chan string, 1)
	s.state.Login = &LoginStatus{ID: newID(), Provider: providerID, Phase: "working", Message: "Starting sign-in…"}
	id, done := s.state.Login.ID, s.loginDone
	authPath := s.config.AuthPath
	s.changedLocked()
	s.mu.Unlock()
	interaction := authtypes.NewInteraction(ctx, func(promptCtx context.Context, prompt authtypes.AuthPrompt) (string, error) {
		s.mu.Lock()
		s.state.Login.Prompt, s.state.Login.PromptType = prompt.Message, prompt.Type
		s.state.Login.Options = nil
		for _, option := range prompt.Options {
			s.state.Login.Options = append(s.state.Login.Options, LoginOption{option.ID, option.Label})
		}
		s.state.Login.Phase = "prompt"
		s.changedLocked()
		s.mu.Unlock()
		select {
		case answer := <-s.loginAnswer:
			return answer, nil
		case <-promptCtx.Done():
			return "", promptCtx.Err()
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}, func(event authtypes.AuthEvent) {
		s.mu.Lock()
		defer s.mu.Unlock()
		if event.Message != nil {
			s.state.Login.Message = *event.Message
		}
		if event.Instructions != nil {
			s.state.Login.Message = *event.Instructions
		}
		if event.URL != nil {
			s.state.Login.URL = safeLoginURL(*event.URL)
		}
		if event.VerificationURI != nil {
			s.state.Login.URL = safeLoginURL(*event.VerificationURI)
		}
		if event.UserCode != nil {
			s.state.Login.Code = *event.UserCode
		}
		s.changedLocked()
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
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.state.Login == nil || s.state.Login.ID != id {
			return
		}
		if loginErr != nil || ctx.Err() != nil {
			s.state.Login.Phase, s.state.Login.Message = "error", "Sign-in did not finish. Retry or use an API key."
		} else {
			next := normalizedConfig(s.config)
			connection = next.Connections[providerID]
			connection.UseOAuth, connection.BaseURL, connection.Model = true, base, preferred.Id
			next.Connections[providerID] = connection
			if next.Provider == providerID {
				next.BaseURL = base
				next.APIKey = ""
			}
			if loginErr = s.saveConfigLocked(next); loginErr != nil {
				s.state.Login.Phase, s.state.Login.Message = "error", "Sign-in succeeded but the connection could not be saved."
			} else {
				s.state.Login.Phase, s.state.Login.Message = "complete", "Signed in. Choose this provider's model beside the message box."
			}
		}
		s.state.Login.URL, s.state.Login.Code, s.state.Login.Prompt = "", "", ""
		s.loginCancel = nil
		s.changedLocked()
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
	if s.state.Login == nil || s.state.Login.ID != id || s.state.Login.Phase != "prompt" {
		return errors.New("This login prompt is no longer active")
	}
	select {
	case s.loginAnswer <- answer:
		s.state.Login.Prompt = ""
		s.state.Login.Phase = "working"
		s.changedLocked()
		return nil
	default:
		return errors.New("A login answer is already pending")
	}
}

func (s *Service) CancelOAuth() {
	s.mu.Lock()
	cancel := s.loginCancel
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
	next := normalizedConfig(s.config)
	connection := next.Connections[provider]
	connection.UseOAuth = false
	next.Connections[provider] = connection
	return s.saveConfigLocked(next)
}
