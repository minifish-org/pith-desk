package desk

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/minifish-org/pith-desk/internal/localstore"
	"github.com/minifish-org/pith-desk/internal/testsupport/filefault"
	"github.com/minifish-org/pith/packages/ai"
	authtypes "github.com/minifish-org/pith/packages/ai/auth/types"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
	"github.com/minifish-org/pith/packages/mcp"
)

type refreshAuthBackend struct {
	backend *codingagent.FileAuthStorageBackend
	fail    atomic.Bool
}

func (b *refreshAuthBackend) WithLock(fn func([]byte) ([]byte, error)) error {
	return b.backend.WithLock(func(current []byte) ([]byte, error) {
		next, err := fn(current)
		if err == nil && next != nil && b.fail.Load() {
			return nil, filefault.ErrInjected
		}
		return next, err
	})
}

type refreshProvider struct {
	ai.Provider
	auth      authtypes.ProviderAuth
	delivered *atomic.Int64
	t         *testing.T
}

func (p refreshProvider) ID() string { return "refresh-fixture" }
func (p refreshProvider) GetModels() []aitypes.Model {
	return []aitypes.Model{{Id: "fixture", Provider: "refresh-fixture", Api: aitypes.ApiOpenAICompletions, BaseUrl: "https://example.invalid/v1"}}
}
func (p refreshProvider) Auth() authtypes.ProviderAuth { return p.auth }
func (p refreshProvider) StreamSimple(_ aitypes.Model, _ *aitypes.TranscriptContext, options *aitypes.SimpleStreamOptions) *aitypes.AssistantMessageEventStream {
	if options.APIKey == nil || *options.APIKey != "fixture-new-access" {
		p.t.Error("model did not use refreshed credentials")
	}
	p.delivered.Add(1)
	stream := aitypes.NewAssistantMessageEventStream()
	stream.Push(aitypes.NewDoneEvent(aitypes.StopReasonStop, aitypes.AssistantMessage{Role: aitypes.AssistantMessageRole, StopReason: aitypes.StopReasonStop}))
	return stream
}

func refreshRuntime(t *testing.T, backend codingagent.AuthStorageBackend, refresh func(context.Context, *authtypes.OAuthCredential) (*authtypes.OAuthCredential, error), delivered *atomic.Int64) *codingagent.ModelRuntime {
	t.Helper()
	runtime, err := codingagent.CreateModelRuntime(codingagent.CreateModelRuntimeOptions{Credentials: codingagent.AuthStorageFromBackend(backend)})
	if err != nil {
		t.Fatal(err)
	}
	runtime.RegisterNativeProvider(refreshProvider{Provider: runtime.GetProvider("deepseek"), t: t, delivered: delivered, auth: authtypes.ProviderAuth{OAuth: &authtypes.OAuthAuth{
		Name: "Fixture OAuth", Refresh: refresh, ToAuth: func(_ context.Context, c *authtypes.OAuthCredential) (authtypes.ModelAuth, error) {
			return authtypes.ModelAuth{APIKey: &c.Access}, nil
		},
	}}})
	if err := runtime.GetError(); err != "" {
		t.Fatal(err)
	}
	return runtime
}

func modelRefreshStream(t *testing.T, ctx context.Context, runtime *codingagent.ModelRuntime, gate chan struct{}) *aitypes.AssistantMessageEventStream {
	t.Helper()
	config := savedConfig{Provider: "refresh-fixture", Connections: map[string]savedConnection{"refresh-fixture": {UseOAuth: true}}}
	fn, err := streamForRuntimeWithAuthGate(ctx, config, runtime, gate)
	if err != nil {
		t.Fatal(err)
	}
	return fn(&aitypes.Model{Id: "fixture", Provider: "refresh-fixture", Api: aitypes.ApiOpenAICompletions}, aitypes.NewTranscriptContext(nil), nil)
}

func TestModelRefreshSharesFileCancelsWaiterAndRecoversSaveFailure(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	path := filepath.Join(t.TempDir(), "auth.json")
	auth := codingagent.CreateAuthStorage(path)
	_, err := auth.Modify(ctx, "refresh-fixture", func(authtypes.Credential) (authtypes.Credential, error) {
		return authtypes.NewOAuthCredential("fixture-old-refresh", "fixture-old-access", 0), nil
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = auth.Modify(ctx, "other-provider", func(authtypes.Credential) (authtypes.Credential, error) {
		return authtypes.NewApiKeyCredential("fixture-other-key"), nil
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	started, release := make(chan struct{}), make(chan struct{})
	var refreshed, delivered atomic.Int64
	var reject atomic.Bool
	refresh := func(ctx context.Context, _ *authtypes.OAuthCredential) (*authtypes.OAuthCredential, error) {
		if reject.Load() {
			return nil, errors.New("fixture-private-model-refresh")
		}
		if refreshed.Add(1) == 1 {
			close(started)
			select {
			case <-release:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		return authtypes.NewOAuthCredential("fixture-new-refresh", "fixture-new-access", float64(time.Now().Add(time.Hour).UnixMilli())), nil
	}
	backend := &refreshAuthBackend{backend: codingagent.NewFileAuthStorageBackend(path)}
	a, b := refreshRuntime(t, backend, refresh, &delivered), refreshRuntime(t, backend, refresh, &delivered)
	gate := make(chan struct{}, 1)
	first := make(chan *aitypes.AssistantMessageEventStream, 1)
	go func() { first <- modelRefreshStream(t, ctx, a, gate) }()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("refresh did not start")
	}
	waiterCtx, stopWaiter := context.WithCancel(ctx)
	stopWaiter()
	failed := modelRefreshStream(t, waiterCtx, b, gate)
	result, err := failed.Result(ctx)
	if err != nil || result.ErrorMessage == nil || !strings.Contains(*result.ErrorMessage, "canceled") {
		t.Fatalf("waiter did not cancel: %+v %v", result, err)
	}
	second := make(chan *aitypes.AssistantMessageEventStream, 1)
	go func() { second <- modelRefreshStream(t, ctx, b, gate) }()
	close(release)
	for _, done := range []chan *aitypes.AssistantMessageEventStream{first, second} {
		select {
		case stream := <-done:
			result, err = stream.Result(ctx)
			if err != nil || result.StopReason != aitypes.StopReasonStop {
				t.Fatalf("refresh: %+v %v", result, err)
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	if refreshed.Load() != 1 || delivered.Load() != 2 || len(gate) != 0 {
		t.Fatalf("refresh/delivery/gate: %d/%d/%d", refreshed.Load(), delivered.Load(), len(gate))
	}
	// Re-expire, fail the SDK file commit, then prove the same gate can recover.
	_, err = auth.Modify(ctx, "refresh-fixture", func(authtypes.Credential) (authtypes.Credential, error) {
		return authtypes.NewOAuthCredential("fixture-old-refresh", "fixture-old-access", 0), nil
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	old, _ := os.ReadFile(path)
	backend.fail.Store(true)
	result, err = modelRefreshStream(t, ctx, refreshRuntime(t, backend, refresh, &delivered), gate).Result(ctx)
	if err != nil || result.ErrorMessage == nil || !strings.Contains(*result.ErrorMessage, "authentication failed") || delivered.Load() != 2 || len(gate) != 0 {
		t.Fatalf("save failure: %+v %v", result, err)
	}
	actual, _ := os.ReadFile(path)
	if !bytes.Equal(old, actual) {
		t.Fatal("failed refresh changed credentials")
	}
	backend.fail.Store(false)
	reject.Store(true)
	result, err = modelRefreshStream(t, ctx, refreshRuntime(t, backend, refresh, &delivered), gate).Result(ctx)
	if err != nil || result.ErrorMessage == nil || strings.Contains(*result.ErrorMessage, "fixture-private") || delivered.Load() != 2 || len(gate) != 0 {
		t.Fatalf("refresh failure: %+v %v", result, err)
	}
	actual, _ = os.ReadFile(path)
	if !bytes.Equal(old, actual) {
		t.Fatal("failed refresh replaced credentials")
	}
	reject.Store(false)
	backend.fail.Store(false)
	result, err = modelRefreshStream(t, ctx, refreshRuntime(t, backend, refresh, &delivered), gate).Result(ctx)
	if err != nil || result.StopReason != aitypes.StopReasonStop || delivered.Load() != 3 {
		t.Fatalf("retry failed: %+v %v", result, err)
	}
	other, err := auth.Read(ctx, "other-provider", nil)
	data, marshalErr := json.Marshal(other)
	if err != nil || marshalErr != nil || !strings.Contains(string(data), "fixture-other-key") {
		t.Fatalf("other provider lost: %v", err)
	}
}

func TestMCPRefreshSerializesCancelsWaiterAndRecoversFailures(t *testing.T) {
	for _, failure := range []string{"none", "refresh", "save"} {
		t.Run(failure, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			started, release := make(chan struct{}), make(chan struct{})
			var calls atomic.Int64
			var reject atomic.Bool
			reject.Store(failure == "refresh")
			var base string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource":
					json.NewEncoder(w).Encode(map[string]any{"resource": base + "/mcp", "authorization_servers": []string{base}})
				case "/.well-known/oauth-authorization-server", "/.well-known/openid-configuration":
					json.NewEncoder(w).Encode(map[string]any{"issuer": base, "authorization_endpoint": base + "/authorize", "token_endpoint": base + "/token", "response_types_supported": []string{"code"}, "token_endpoint_auth_methods_supported": []string{"none"}})
				case "/token":
					if err := r.ParseForm(); err != nil || r.Form.Get("grant_type") != "refresh_token" || r.Form.Get("refresh_token") != "fixture-refresh" {
						http.Error(w, "invalid refresh", 400)
						return
					}
					if calls.Add(1) == 1 {
						close(started)
						select {
						case <-release:
						case <-r.Context().Done():
							return
						}
					}
					if reject.Load() {
						http.Error(w, "fixture-private-refresh-rejected", 400)
						return
					}
					json.NewEncoder(w).Encode(map[string]any{"access_token": "fixture-new-token", "refresh_token": "fixture-refresh", "token_type": "Bearer", "expires_in": 3600})
				default:
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			base = server.URL
			config := savedMCP{Name: "refresh", Type: "http", URL: base + "/mcp", OAuth: true, OAuthClientID: "fixture-client"}
			store := mcpOAuthFile{path: filepath.Join(t.TempDir(), "oauth.json")}
			expired := time.Now().Add(-time.Minute).UnixMilli()
			if err := store.Save(mcp.McpOAuthState{ServerURL: config.URL, ClientInformation: &mcp.OAuthClientInformation{ClientID: "fixture-client"}, Tokens: &mcp.OAuthTokens{AccessToken: "fixture-old-token", RefreshToken: "fixture-refresh"}, TokensExpireAt: &expired}); err != nil {
				t.Fatal(err)
			}
			old, _ := os.ReadFile(store.path)
			provider := newMCPTokenProvider(config, store)
			if failure == "save" {
				provider.store.files = localstore.Store{FS: &filefault.FS{Step: "rename"}}
			}
			first := make(chan error, 1)
			go func() {
				token, err := provider.Token(ctx)
				if failure == "none" && token != "fixture-new-token" {
					t.Error("wrong first token")
				}
				first <- err
			}()
			// Discovery can persist before the refresh; otherwise release the
			// token response and fail the credential commit after exchange.
			if failure == "save" {
				select {
				case err := <-first:
					if err == nil {
						t.Fatal("save failure hidden")
					}
					close(release)
				case <-started:
					close(release)
					select {
					case err := <-first:
						if err == nil {
							t.Fatal("save failure hidden")
						}
					case <-ctx.Done():
						t.Fatal(ctx.Err())
					}
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
			} else {
				select {
				case <-started:
				case <-ctx.Done():
					t.Fatal("refresh did not start")
				}
				waiterCtx, stop := context.WithCancel(ctx)
				stop()
				if _, err := provider.Token(waiterCtx); !errors.Is(err, context.Canceled) {
					t.Fatalf("waiter: %v", err)
				}
				second := make(chan error, 1)
				go func() {
					token, err := provider.Token(ctx)
					if failure == "none" && token != "fixture-new-token" {
						t.Error("wrong second token")
					}
					second <- err
				}()
				close(release)
				for _, done := range []chan error{first, second} {
					select {
					case err := <-done:
						if (failure == "none") != (err == nil) {
							t.Fatalf("refresh result: %v", err)
						}
						if err != nil && strings.Contains(err.Error(), "fixture-private") {
							t.Fatal("secret leaked")
						}
					case <-ctx.Done():
						t.Fatal(ctx.Err())
					}
				}
				if failure == "none" && calls.Load() != 1 {
					t.Fatalf("duplicate refresh: %d", calls.Load())
				}
			}
			if len(provider.gate) != 0 {
				t.Fatal("refresh gate leaked")
			}
			if failure == "save" {
				actual, _ := os.ReadFile(store.path)
				if !bytes.Equal(old, actual) {
					t.Fatal("failed save replaced auth commit")
				}
			}
			reject.Store(false)
			provider.store.files = localstore.Store{}
			token, err := provider.Token(ctx)
			if err != nil || token != "fixture-new-token" {
				t.Fatalf("retry: %q %v", token, err)
			}
		})
	}
}

func TestConnectionsShareTokenProviderButKeepMCPTransportsIndependent(t *testing.T) {
	fixture := newDeskMCPFixture(t, "fixture-new-token", nil)
	s, _, _ := configuredService(t, "http://127.0.0.1:1")
	if err := s.SaveMCP(MCPInput{Name: "shared-auth", Type: "http", URL: fixture.server.URL, OAuth: true, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	config := s.connections.mcpConfigs[0]
	expiry := time.Now().Add(time.Hour).UnixMilli()
	if err := s.mcpOAuthStore(config).Save(mcp.McpOAuthState{ServerURL: config.URL, Tokens: &mcp.OAuthTokens{AccessToken: "fixture-new-token", RefreshToken: "fixture-refresh"}, TokensExpireAt: &expiry}); err != nil {
		t.Fatal(err)
	}
	type loaded struct {
		runtime     *codingagent.MCPRuntime
		diagnostics []codingagent.MCPDiagnostic
	}
	results := make(chan loaded, 2)
	for range 2 {
		go func() {
			runtime, diagnostics := s.loadMCPRuntime(context.Background(), []codingagent.MCPServerConfig{config.sdkConfig()})
			results <- loaded{runtime, diagnostics}
		}()
	}
	a, b := <-results, <-results
	defer closeMCPRuntime(b.runtime)
	if len(a.diagnostics) != 0 || len(b.diagnostics) != 0 || a.runtime == b.runtime {
		closeMCPRuntime(a.runtime)
		t.Fatalf("independent transports: %v %v", a.diagnostics, b.diagnostics)
	}
	s.mu.Lock()
	providers := len(s.connections.mcpTokens)
	s.mu.Unlock()
	if providers != 1 {
		closeMCPRuntime(a.runtime)
		t.Fatalf("token providers: %d", providers)
	}
	closeMCPRuntime(a.runtime)
	tools := b.runtime.ToolDefinitions()
	if len(tools) == 0 {
		t.Fatal("second transport lost tools")
	}
	result, err := tools[0].Execute(context.Background(), json.RawMessage(`{"value":"second-transport"}`))
	if err != nil || result.IsError || fixture.calls.Load() != 1 {
		t.Fatalf("closing one transport affected the other: %+v %v", result, err)
	}
}
