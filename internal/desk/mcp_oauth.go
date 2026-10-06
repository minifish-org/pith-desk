package desk

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	codingagent "github.com/minifish-org/pith/packages/coding-agent"
	"github.com/minifish-org/pith/packages/mcp"
)

// The SDK owns discovery, registration, PKCE, exchange and token refresh.
// The host supplies only a private file store and loopback callback/UI.
type mcpOAuthFile struct{ path string }

func (f mcpOAuthFile) Load() (*mcp.McpOAuthState, error) {
	if _, err := os.Stat(f.path); errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	var state mcp.McpOAuthState
	if err := readJSON(f.path, &state); err != nil {
		return nil, err
	}
	return &state, nil
}
func (f mcpOAuthFile) Save(state mcp.McpOAuthState) error { return writeJSON(f.path, state) }
func (s *Service) mcpOAuthStore(config savedMCP) mcpOAuthFile {
	key := sha256.Sum256([]byte(config.Name + "\x00" + config.URL))
	return mcpOAuthFile{filepath.Join(s.dataDir, "mcp-auth", hex.EncodeToString(key[:])+".json")}
}

const mcpCallbackURL = "http://127.0.0.1:54819/oauth/callback"

func mcpFlow(config savedMCP, store mcp.McpOAuthStateStore, redirect func(string) error) *mcp.McpOAuthProvider {
	return codingagent.NewMCPOAuthFlowProvider(codingagent.MCPOAuthProviderOptions{
		ServerURL: config.URL, RedirectURL: mcpCallbackURL, Store: store,
		Config: codingagent.MCPOAuthConfig{ClientName: "Pith Desk", ClientID: config.OAuthClientID, Scope: config.OAuthScope}, OnRedirect: redirect,
	})
}

type mcpTokenProvider struct {
	mu       sync.Mutex
	config   savedMCP
	store    mcpOAuthFile
	provider mcp.AuthProvider
}

func newMCPTokenProvider(config savedMCP, store mcpOAuthFile) *mcpTokenProvider {
	flow := mcpFlow(config, store, func(string) error { return errors.New("Sign in to this MCP connection again") })
	return &mcpTokenProvider{config: config, store: store, provider: mcp.AdaptOAuthProvider(flow)}
}

func (p *mcpTokenProvider) OnUnauthorized(ctx context.Context, challenge mcp.UnauthorizedContext) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.provider.(mcp.UnauthorizedHandler).OnUnauthorized(ctx, challenge)
}

func (p *mcpTokenProvider) Token(ctx context.Context) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	state, err := p.store.Load()
	if err != nil {
		return "", errors.New("MCP OAuth credentials could not be read")
	}
	if state == nil || state.Tokens == nil || state.ServerURL != p.config.URL {
		return "", errors.New("Sign in to this MCP connection first")
	}
	if state.TokensExpireAt != nil && *state.TokensExpireAt <= time.Now().Add(30*time.Second).UnixMilli() {
		flow := mcpFlow(p.config, p.store, func(string) error { return errors.New("Sign in again") })
		result, err := mcp.AuthorizeMcp(ctx, flow, mcp.OAuthFlowOptions{ServerURL: p.config.URL, Scope: p.config.OAuthScope})
		if err != nil || result != mcp.OAuthFlowAuthorized {
			return "", errors.New("MCP OAuth expired; sign in again")
		}
		state, err = p.store.Load()
		if err != nil || state == nil || state.Tokens == nil {
			return "", errors.New("MCP OAuth refresh did not save a token")
		}
	}
	return state.Tokens.AccessToken, nil
}

func (s *Service) StartMCPOAuth(name string) error {
	s.mu.Lock()
	if err := s.idleLocked(); err != nil {
		s.mu.Unlock()
		return err
	}
	var config savedMCP
	for _, candidate := range s.mcpConfigs {
		if candidate.Name == name {
			config = candidate
		}
	}
	if config.Type != "http" || !config.OAuth {
		s.mu.Unlock()
		return errors.New("Enable OAuth on this HTTP MCP connection first")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:54819")
	if err != nil {
		s.mu.Unlock()
		return errors.New("MCP sign-in callback port 54819 is busy")
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.loginCancel, s.loginDone = cancel, make(chan struct{})
	id, done := newID(), s.loginDone
	s.state.Login = &LoginStatus{ID: id, Provider: name, Phase: "working", Message: "Starting MCP sign-in…"}
	store := s.mcpOAuthStore(config)
	s.changedLocked()
	s.mu.Unlock()
	go func() {
		defer close(done)
		defer cancel()
		defer listener.Close()
		callback := make(chan mcp.OAuthFlowOptions, 1)
		flow := mcpFlow(config, store, func(url string) error {
			if safeLoginURL(url) == "" {
				return errors.New("Authorization URL must use HTTPS")
			}
			s.mu.Lock()
			s.state.Login.URL, s.state.Login.Message = url, "Open the sign-in page; this window will update after authorization."
			s.changedLocked()
			s.mu.Unlock()
			return nil
		})
		mux := http.NewServeMux()
		mux.HandleFunc("GET /oauth/callback", func(w http.ResponseWriter, r *http.Request) {
			state, err := store.Load()
			expected := ""
			if state != nil {
				expected = state.OAuthState
			}
			if err != nil || expected == "" || subtle.ConstantTimeCompare([]byte(expected), []byte(r.URL.Query().Get("state"))) != 1 || r.URL.Query().Get("code") == "" {
				http.Error(w, "Invalid sign-in callback", http.StatusBadRequest)
				return
			}
			options := mcp.OAuthFlowOptions{ServerURL: config.URL, Scope: config.OAuthScope, AuthorizationCode: r.URL.Query().Get("code"), ISS: r.URL.Query().Get("iss"), HasISS: r.URL.Query().Has("iss")}
			select {
			case callback <- options:
				fmt.Fprint(w, "Sign-in received. Return to Pith Desk.")
			default:
				http.Error(w, "Callback already received", http.StatusConflict)
			}
		})
		server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
		go func() { _ = server.Serve(listener) }()
		defer server.Close()
		result, loginErr := mcp.AuthorizeMcp(ctx, flow, mcp.OAuthFlowOptions{ServerURL: config.URL, Scope: config.OAuthScope})
		if loginErr == nil && result == mcp.OAuthFlowRedirect {
			select {
			case options := <-callback:
				result, loginErr = mcp.AuthorizeMcp(ctx, flow, options)
			case <-ctx.Done():
				loginErr = ctx.Err()
			}
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		s.state.Login.URL = ""
		if loginErr != nil || ctx.Err() != nil || result != mcp.OAuthFlowAuthorized {
			s.state.Login.Phase, s.state.Login.Message = "error", "MCP sign-in did not finish. Check this server's OAuth support and retry."
		} else {
			s.state.Login.Phase, s.state.Login.Message = "complete", "MCP sign-in complete. Connect or reconnect this server to load its tools."
		}
		s.loginCancel = nil
		s.changedLocked()
	}()
	return nil
}

func (s *Service) LogoutMCPOAuth(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.idleLocked(); err != nil {
		return err
	}
	for _, config := range s.mcpConfigs {
		if config.Name == name {
			err := os.Remove(s.mcpOAuthStore(config).path)
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			return err
		}
	}
	return errors.New("MCP connection not found")
}
