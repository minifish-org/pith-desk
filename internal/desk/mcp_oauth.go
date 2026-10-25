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
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/minifish-org/pith-desk/internal/localstore"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
	"github.com/minifish-org/pith/packages/mcp"
)

// The SDK owns discovery, registration, PKCE, exchange and token refresh.
// The host supplies a private file store and either a loopback callback
// (Desktop) or a pasted redirect URL (Server).
type mcpOAuthFile struct {
	path  string
	files localstore.Store
}

func (f mcpOAuthFile) Load() (*mcp.McpOAuthState, error) {
	if _, err := os.Stat(f.path); errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	var state mcp.McpOAuthState
	if err := f.files.ReadJSON(f.path, &state); err != nil {
		return nil, err
	}
	return &state, nil
}
func (f mcpOAuthFile) Save(state mcp.McpOAuthState) error { return f.files.WriteJSON(f.path, state) }
func (c *Connections) mcpOAuthStore(config savedMCP, files localstore.Store) mcpOAuthFile {
	key := sha256.Sum256([]byte(config.Name + "\x00" + config.URL))
	return mcpOAuthFile{path: filepath.Join(c.dataDir, "mcp-auth", hex.EncodeToString(key[:])+".json"), files: files}
}

func (s *Service) mcpOAuthStore(config savedMCP) mcpOAuthFile {
	return s.connections.mcpOAuthStore(config, s.files)
}

const mcpCallbackURL = "http://127.0.0.1:54819/oauth/callback"

func mcpFlow(config savedMCP, store mcp.McpOAuthStateStore, redirect func(string) error) *mcp.McpOAuthProvider {
	return codingagent.NewMCPOAuthFlowProvider(codingagent.MCPOAuthProviderOptions{
		ServerURL: config.URL, RedirectURL: mcpCallbackURL, Store: store,
		Config: codingagent.MCPOAuthConfig{ClientName: "Pith Desk", ClientID: config.OAuthClientID, Scope: config.OAuthScope}, OnRedirect: redirect,
	})
}

type mcpTokenProvider struct {
	gate     chan struct{}
	config   savedMCP
	store    mcpOAuthFile
	provider mcp.AuthProvider
}

func newMCPTokenProvider(config savedMCP, store mcpOAuthFile) *mcpTokenProvider {
	flow := mcpFlow(config, store, func(string) error { return errors.New("Sign in to this MCP connection again") })
	return &mcpTokenProvider{gate: make(chan struct{}, 1), config: config, store: store, provider: mcp.AdaptOAuthProvider(flow)}
}

func (p *mcpTokenProvider) OnUnauthorized(ctx context.Context, challenge mcp.UnauthorizedContext) error {
	select {
	case p.gate <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() { <-p.gate }()
	return p.provider.(mcp.UnauthorizedHandler).OnUnauthorized(ctx, challenge)
}

func (p *mcpTokenProvider) Token(ctx context.Context) (string, error) {
	select {
	case p.gate <- struct{}{}:
	case <-ctx.Done():
		return "", ctx.Err()
	}
	defer func() { <-p.gate }()
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
	return s.connections.startMCPOAuth(name, s.files, false, s.idleLocked, s.changedLocked)
}

// StartServerMCPOAuth runs the same SDK flow without a loopback listener. The
// user authorizes in a browser and pastes the final redirect URL back; Pith
// still checks the saved state and exchanges the code with the PKCE verifier
// stored on this host.
func (s *Service) StartServerMCPOAuth(name string) error {
	return s.connections.startMCPOAuth(name, s.files, true, s.idleLocked, s.changedLocked)
}

func (c *Connections) startMCPOAuth(name string, files localstore.Store, manual bool, canStart func() error, changed func()) error {
	c.mu.Lock()
	if err := canStart(); err != nil {
		c.mu.Unlock()
		return err
	}
	var config savedMCP
	for _, candidate := range c.mcpConfigs {
		if candidate.Name == name {
			config = candidate
		}
	}
	if config.Type != "http" || !config.OAuth {
		c.mu.Unlock()
		return errors.New("Enable OAuth on this HTTP MCP connection first")
	}
	if err := c.prepareMCPAuthChange(files); err != nil {
		c.mu.Unlock()
		return err
	}
	var listener net.Listener
	if !manual {
		var err error
		listener, err = net.Listen("tcp", "127.0.0.1:54819")
		if err != nil {
			c.mu.Unlock()
			return errors.New("MCP sign-in callback port 54819 is busy")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	c.loginCancel, c.loginDone = cancel, make(chan struct{})
	if manual {
		c.loginAnswer = make(chan string, 1)
	}
	id, done := newID(), c.loginDone
	c.Login = &LoginStatus{ID: id, Provider: name, Phase: "working", Message: "Starting MCP sign-in…"}
	store := c.mcpOAuthStore(config, files)
	changed()
	c.mu.Unlock()
	go func() {
		defer close(done)
		defer cancel()
		if listener != nil {
			defer listener.Close()
		}
		callback := make(chan mcp.OAuthFlowOptions, 1)
		flow := mcpFlow(config, store, func(url string) error {
			if safeLoginURL(url) == "" {
				return errors.New("Authorization URL must use HTTPS")
			}
			c.mu.Lock()
			c.Login.URL, c.Login.Message = url, "Open the sign-in page; this window will update after authorization."
			changed()
			c.mu.Unlock()
			return nil
		})
		if listener != nil {
			mux := http.NewServeMux()
			mux.HandleFunc("GET /oauth/callback", func(w http.ResponseWriter, r *http.Request) {
				options, err := mcpOAuthOptions(config, r.URL.Query(), store)
				if err != nil {
					http.Error(w, "Invalid sign-in callback", http.StatusBadRequest)
					return
				}
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
		}
		result, loginErr := mcp.AuthorizeMcp(ctx, flow, mcp.OAuthFlowOptions{ServerURL: config.URL, Scope: config.OAuthScope})
		if loginErr == nil && result == mcp.OAuthFlowRedirect {
			if manual {
				c.mu.Lock()
				c.Login.Phase = "prompt"
				c.Login.Message = "Authorize on the provider page, then paste the complete redirect URL from the browser address bar. The page may show a connection error; that is expected."
				c.Login.Prompt = "Complete redirect URL"
				c.Login.PromptType = "url"
				changed()
				c.mu.Unlock()
				var answer string
				select {
				case answer = <-c.loginAnswer:
				case <-ctx.Done():
					loginErr = ctx.Err()
				}
				if loginErr == nil {
					options, err := mcpPastedOAuthOptions(answer, config, store)
					if err != nil {
						loginErr = err
					} else {
						result, loginErr = mcp.AuthorizeMcp(ctx, flow, options)
					}
				}
			} else {
				select {
				case options := <-callback:
					result, loginErr = mcp.AuthorizeMcp(ctx, flow, options)
				case <-ctx.Done():
					loginErr = ctx.Err()
				}
			}
		}
		c.mu.Lock()
		defer c.mu.Unlock()
		c.Login.URL = ""
		c.Login.Prompt = ""
		c.Login.PromptType = ""
		if loginErr != nil || ctx.Err() != nil || result != mcp.OAuthFlowAuthorized {
			message := "MCP sign-in did not finish. Check this server's OAuth support and retry."
			var redirectErr *mcpRedirectError
			if errors.As(loginErr, &redirectErr) {
				message = redirectErr.message
			}
			c.Login.Phase, c.Login.Message = "error", message
		} else {
			c.Login.Phase, c.Login.Message = "complete", "MCP sign-in complete. Connect or reconnect this server to load its tools."
		}
		c.loginCancel = nil
		changed()
	}()
	return nil
}

type mcpRedirectError struct{ message string }

func (e *mcpRedirectError) Error() string { return e.message }

// mcpOAuthOptions validates the SDK-generated state and builds the exchange
// options shared by the Desktop callback and the Server pasted URL.
func mcpOAuthOptions(config savedMCP, query url.Values, store mcp.McpOAuthStateStore) (mcp.OAuthFlowOptions, error) {
	if code := query.Get("error"); code != "" {
		description := query.Get("error_description")
		if description == "" {
			description = code
		}
		return mcp.OAuthFlowOptions{}, &mcpRedirectError{"MCP sign-in was not completed: " + description}
	}
	state, err := store.Load()
	if err != nil {
		return mcp.OAuthFlowOptions{}, errors.New("MCP sign-in state could not be read")
	}
	if state == nil || state.ServerURL != config.URL || state.OAuthState == "" || subtle.ConstantTimeCompare([]byte(state.OAuthState), []byte(query.Get("state"))) != 1 {
		return mcp.OAuthFlowOptions{}, &mcpRedirectError{"The redirect URL does not match this sign-in attempt. Start the sign-in again."}
	}
	code := query.Get("code")
	if code == "" {
		return mcp.OAuthFlowOptions{}, &mcpRedirectError{"The redirect URL does not contain an authorization code."}
	}
	return mcp.OAuthFlowOptions{
		ServerURL:         config.URL,
		Scope:             config.OAuthScope,
		AuthorizationCode: code,
		ISS:               query.Get("iss"),
		HasISS:            query.Has("iss"),
	}, nil
}

// mcpPastedOAuthOptions rejects arbitrary pasted text before it can reach the
// SDK. Only this flow's registered loopback redirect URI is accepted; the
// browser may show a connection error there, but its address bar keeps the code.
func mcpPastedOAuthOptions(answer string, config savedMCP, store mcp.McpOAuthStateStore) (mcp.OAuthFlowOptions, error) {
	parsed, err := url.Parse(strings.TrimSpace(answer))
	if err != nil {
		return mcp.OAuthFlowOptions{}, &mcpRedirectError{"Paste the complete redirect URL from the browser address bar."}
	}
	expected, _ := url.Parse(mcpCallbackURL)
	if parsed.Scheme != expected.Scheme || parsed.Host != expected.Host || parsed.Path != expected.Path || parsed.User != nil {
		return mcp.OAuthFlowOptions{}, &mcpRedirectError{"That is not the MCP sign-in redirect URL. Paste the complete address from the browser."}
	}
	return mcpOAuthOptions(config, parsed.Query(), store)
}

func (s *Service) LogoutMCPOAuth(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.idleLocked(); err != nil {
		return err
	}
	for _, config := range s.connections.mcpConfigs {
		if config.Name == name {
			if err := s.connections.prepareMCPAuthChange(s.files); err != nil {
				return err
			}
			err := os.Remove(s.mcpOAuthStore(config).path)
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			return err
		}
	}
	return errors.New("MCP connection not found")
}
