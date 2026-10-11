package desk

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/minifish-org/pith-desk/internal/localstore"
	"github.com/minifish-org/pith-desk/internal/testsupport/filefault"
	"github.com/minifish-org/pith/packages/mcp"
)

func TestMCPChangedConfigurationPreservesOAuthUntilCommit(t *testing.T) {
	for _, stage := range []string{"write", "sync", "close", "rename"} {
		for _, change := range []string{"endpoint", "oauth", "client", "scope"} {
			t.Run(stage+"/"+change, func(t *testing.T) {
				s, dir, _ := fixedPersistenceService(t)
				previous := s.connections.mcpConfigs[0]
				input := MCPInput{Name: previous.Name, Type: previous.Type, URL: previous.URL, OAuth: previous.OAuth, OAuthClientID: previous.OAuthClientID, OAuthScope: previous.OAuthScope, Enabled: previous.Enabled}
				switch change {
				case "endpoint":
					input.URL = "https://changed.example.invalid/mcp"
				case "oauth":
					input.OAuth = false
				case "client":
					input.OAuthClientID = "fixture-new-client"
				case "scope":
					input.OAuthScope = "fixture-new-scope"
				}
				oldConfig, _ := os.ReadFile(filepath.Join(dir, "mcp.json"))
				oldAuth, _ := os.ReadFile(s.mcpOAuthStore(previous).path)
				public := s.ListMCP()
				s.files = localstore.Store{FS: &filefault.FS{Step: stage}}
				if err := s.SaveMCP(input); !errors.Is(err, filefault.ErrInjected) {
					t.Fatalf("missing failure: %v", err)
				}
				actualConfig, _ := os.ReadFile(filepath.Join(dir, "mcp.json"))
				actualAuth, _ := os.ReadFile(s.mcpOAuthStore(previous).path)
				if !bytes.Equal(oldConfig, actualConfig) || !bytes.Equal(oldAuth, actualAuth) || !reflect.DeepEqual(public, s.ListMCP()) {
					t.Fatal("failed config save discarded old login or config")
				}
				s.files = localstore.Store{}
				if err := s.SaveMCP(input); err != nil {
					t.Fatal(err)
				}
				if s.ListMCP()[0].SignedIn {
					t.Fatal("new config reused old OAuth")
				}
				next := s.connections.mcpConfigs[0]
				if _, err := newMCPTokenProvider(next, s.mcpOAuthStore(next)).Token(context.Background()); err == nil {
					t.Fatal("new config accepted old token")
				}
				expiry := time.Now().Add(time.Hour).UnixMilli()
				// A fresh authorization can persist and be read after the failed save/retry.
				if err := s.mcpOAuthStore(next).Save(mcp.McpOAuthState{ServerURL: next.URL, Tokens: &mcp.OAuthTokens{AccessToken: "fixture-new-login", RefreshToken: "fixture-new-refresh"}, TokensExpireAt: &expiry}); err != nil {
					t.Fatal(err)
				}
				token, err := newMCPTokenProvider(next, s.mcpOAuthStore(next)).Token(context.Background())
				if err != nil || token != "fixture-new-login" {
					t.Fatalf("fresh login: %q %v", token, err)
				}
			})
		}
	}
}

func TestMCPAuthBackupRecoveryUsesCommittedConfiguration(t *testing.T) {
	for _, committed := range []bool{false, true} {
		t.Run(map[bool]string{false: "before-config-commit", true: "after-config-commit"}[committed], func(t *testing.T) {
			s, dir, _ := fixedPersistenceService(t)
			old := s.connections.mcpConfigs[0]
			pending, err := s.connections.stageMCPAuth(old, s.files)
			if err != nil || pending == nil {
				t.Fatalf("stage: %v", err)
			}
			saved, _ := os.ReadFile(pending.backup)
			if committed {
				next := append([]savedMCP(nil), s.connections.mcpConfigs...)
				next[0].OAuthScope = "changed-scope"
				if err := s.files.WriteJSON(filepath.Join(dir, "mcp.json"), next); err != nil {
					t.Fatal(err)
				}
			}
			s.Close()
			reopened, err := New(dir)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			if reopened.ListMCP()[0].SignedIn == committed {
				t.Fatal("restart did not follow committed config")
			}
			if _, err := os.Stat(pending.backup); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("pending backup retained: %v", err)
			}
			if !committed {
				actual, _ := os.ReadFile(pending.path)
				if !bytes.Equal(saved, actual) {
					t.Fatal("old auth payload changed during recovery")
				}
			}
		})
	}
}

func TestMCPRemovalFailurePreservesConfigurationAndOAuth(t *testing.T) {
	for _, stage := range []string{"mkdir", "create", "write", "sync", "close", "rename"} {
		for _, signedIn := range []bool{true, false} {
			t.Run(stage+"/"+map[bool]string{true: "signed-in", false: "no-credentials"}[signedIn], func(t *testing.T) {
				s, dir, _ := fixedPersistenceService(t)
				config := s.connections.mcpConfigs[0]
				authPath := s.mcpOAuthStore(config).path
				if !signedIn {
					if err := os.Remove(authPath); err != nil {
						t.Fatal(err)
					}
				}
				if err := s.SaveMCP(MCPInput{Name: "other-mcp", Type: "http", URL: "https://other.example.invalid/mcp", OAuth: true}); err != nil {
					t.Fatal(err)
				}
				other := s.connections.mcpConfigs[1]
				otherStore := s.mcpOAuthStore(other)
				if err := otherStore.Save(mcp.McpOAuthState{ServerURL: other.URL, Tokens: &mcp.OAuthTokens{AccessToken: "fixture-other-login"}}); err != nil {
					t.Fatal(err)
				}
				read := func(path string) []byte {
					t.Helper()
					data, err := os.ReadFile(path)
					if err != nil {
						t.Fatal(err)
					}
					return data
				}
				assertNoCredentials := func() {
					t.Helper()
					if _, err := os.Stat(authPath); !errors.Is(err, os.ErrNotExist) {
						t.Fatalf("removed credentials remain: %v", err)
					}
				}
				assertNoBackups := func() {
					t.Helper()
					paths, err := filepath.Glob(filepath.Join(dir, "mcp-auth", "*.pending-*"))
					if err != nil || len(paths) != 0 {
						t.Fatalf("pending credentials remain: %v %v", paths, err)
					}
				}
				oldConfig, otherAuth := read(filepath.Join(dir, "mcp.json")), read(otherStore.path)
				var oldAuth []byte
				if signedIn {
					oldAuth = read(authPath)
				}
				public := s.ListMCP()
				provider := newMCPTokenProvider(config, s.mcpOAuthStore(config))
				s.connections.mcpTokens[authPath] = provider
				s.files = localstore.Store{FS: &filefault.FS{Step: stage}}
				err := s.RemoveMCP(config.Name)
				s.files = localstore.Store{}
				if !errors.Is(err, filefault.ErrInjected) {
					t.Fatalf("missing %s failure: %v", stage, err)
				}
				if !bytes.Equal(oldConfig, read(filepath.Join(dir, "mcp.json"))) || !reflect.DeepEqual(public, s.ListMCP()) || s.connections.mcpTokens[authPath] != provider {
					t.Fatal("failed removal changed configuration, login, or cached provider")
				}
				if signedIn {
					if !bytes.Equal(oldAuth, read(authPath)) {
						t.Fatal("failed removal changed old OAuth payload")
					}
					if token, err := provider.Token(context.Background()); err != nil || token != "fixture-access" {
						t.Fatalf("old login is unusable: %q %v", token, err)
					}
				} else {
					assertNoCredentials()
				}
				assertNoBackups()
				if !bytes.Equal(otherAuth, read(otherStore.path)) {
					t.Fatal("failed removal changed another connection's credentials")
				}
				s.Close()
				reopened, err := New(dir)
				if err != nil {
					t.Fatal(err)
				}
				defer reopened.Close()
				if !reflect.DeepEqual(public, reopened.ListMCP()) {
					t.Fatal("restart lost configuration or login after failed removal")
				}
				if signedIn {
					if token, err := newMCPTokenProvider(config, reopened.mcpOAuthStore(config)).Token(context.Background()); err != nil || token != "fixture-access" {
						t.Fatalf("restarted login is unusable: %q %v", token, err)
					}
				}
				if err := reopened.RemoveMCP(config.Name); err != nil {
					t.Fatalf("retry removal: %v", err)
				}
				if views := reopened.ListMCP(); len(views) != 1 || !reflect.DeepEqual(views[0], public[1]) {
					t.Fatal("retry did not remove only the requested connection")
				}
				assertNoCredentials()
				assertNoBackups()
				if !bytes.Equal(otherAuth, read(otherStore.path)) {
					t.Fatal("successful removal changed another connection's credentials")
				}
				reopened.Close()
				finished, err := New(dir)
				if err != nil {
					t.Fatal(err)
				}
				defer finished.Close()
				if views := finished.ListMCP(); len(views) != 1 || views[0].Name != other.Name || !views[0].SignedIn {
					t.Fatal("successful deletion did not persist across restart")
				}
				if err := finished.SaveMCP(MCPInput{Name: config.Name, Type: config.Type, URL: config.URL, OAuth: true, OAuthClientID: config.OAuthClientID, OAuthScope: config.OAuthScope}); err != nil {
					t.Fatal(err)
				}
				if finished.ListMCP()[1].SignedIn {
					t.Fatal("re-adding the deleted connection reused its old login")
				}
				if _, err := newMCPTokenProvider(config, finished.mcpOAuthStore(config)).Token(context.Background()); err == nil {
					t.Fatal("re-added connection accepted deleted OAuth tokens")
				}
				if err := finished.mcpOAuthStore(config).Save(mcp.McpOAuthState{ServerURL: config.URL, Tokens: &mcp.OAuthTokens{AccessToken: "fixture-fresh-login"}}); err != nil {
					t.Fatal(err)
				}
				if token, err := newMCPTokenProvider(config, finished.mcpOAuthStore(config)).Token(context.Background()); err != nil || token != "fixture-fresh-login" {
					t.Fatalf("new login after re-adding is unusable: %q %v", token, err)
				}
			})
		}
	}
}

func TestMCPRemovalAuthBackupRecoveryUsesCommittedConfiguration(t *testing.T) {
	for _, committed := range []bool{false, true} {
		t.Run(map[bool]string{false: "before-delete-commit", true: "after-delete-commit"}[committed], func(t *testing.T) {
			s, dir, _ := fixedPersistenceService(t)
			config := s.connections.mcpConfigs[0]
			pending, err := s.connections.stageMCPAuth(config, s.files)
			if err != nil || pending == nil {
				t.Fatalf("stage: %v", err)
			}
			saved, err := os.ReadFile(pending.backup)
			if err != nil {
				t.Fatal(err)
			}
			if committed {
				if err := s.files.WriteJSON(filepath.Join(dir, "mcp.json"), []savedMCP{}); err != nil {
					t.Fatal(err)
				}
			}
			s.Close()
			reopened, err := New(dir)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			if _, err := os.Stat(pending.backup); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("restart retained pending backup: %v", err)
			}
			if !committed {
				if views := reopened.ListMCP(); len(views) != 1 || !views[0].SignedIn || views[0].Name != config.Name {
					t.Fatal("restart failed to retain the uncommitted deletion's login")
				}
				actual, err := os.ReadFile(pending.path)
				if err != nil || !bytes.Equal(saved, actual) {
					t.Fatal("restart changed old OAuth payload")
				}
				if token, err := newMCPTokenProvider(config, reopened.mcpOAuthStore(config)).Token(context.Background()); err != nil || token != "fixture-access" {
					t.Fatalf("restored login is unusable: %q %v", token, err)
				}
				if err := reopened.RemoveMCP(config.Name); err != nil {
					t.Fatalf("removal after recovery: %v", err)
				}
			} else {
				if len(reopened.ListMCP()) != 0 {
					t.Fatal("restart restored a committed deletion")
				}
				if _, err := os.Stat(pending.path); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("restart restored deleted credentials: %v", err)
				}
				if err := reopened.SaveMCP(MCPInput{Name: config.Name, Type: config.Type, URL: config.URL, OAuth: true}); err != nil {
					t.Fatal(err)
				}
				if reopened.ListMCP()[0].SignedIn {
					t.Fatal("re-added connection reused a committed deletion's backup")
				}
			}
		})
	}
}

func TestMCPRemovalFailureKeepsPreviewUsable(t *testing.T) {
	fixture := newDeskMCPFixture(t, "fixture-removal-token", nil)
	s, _, _ := configuredService(t, "http://127.0.0.1:1")
	if err := s.SaveMCP(MCPInput{Name: "removal-auth", Type: "http", URL: fixture.server.URL, OAuth: true, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	config := s.connections.mcpConfigs[0]
	expiry := time.Now().Add(time.Hour).UnixMilli()
	if err := s.mcpOAuthStore(config).Save(mcp.McpOAuthState{ServerURL: config.URL, Tokens: &mcp.OAuthTokens{AccessToken: "fixture-removal-token"}, TokensExpireAt: &expiry}); err != nil {
		t.Fatal(err)
	}
	if err := s.ConnectMCP(context.Background()); err != nil {
		t.Fatal(err)
	}
	preview := s.connections.mcpRuntime
	provider := s.connections.mcpTokens[s.mcpOAuthStore(config).path]
	tools := preview.ToolDefinitions()
	if provider == nil || len(tools) == 0 {
		t.Fatal("preview did not connect using OAuth")
	}
	public := s.ListMCP()
	s.files = localstore.Store{FS: &filefault.FS{Step: "rename"}}
	err := s.RemoveMCP(config.Name)
	s.files = localstore.Store{}
	if !errors.Is(err, filefault.ErrInjected) {
		t.Fatalf("missing removal failure: %v", err)
	}
	if s.connections.mcpRuntime != preview || s.connections.mcpTokens[s.mcpOAuthStore(config).path] != provider || !reflect.DeepEqual(public, s.ListMCP()) {
		t.Fatal("failed removal discarded the connected preview or login")
	}
	result, err := tools[0].Execute(context.Background(), json.RawMessage(`{"value":"after-failed-removal"}`))
	if err != nil || result.IsError || fixture.calls.Load() != 1 {
		t.Fatalf("old preview is unusable after failed removal: %+v %v", result, err)
	}
	if err := s.RemoveMCP(config.Name); err != nil {
		t.Fatal(err)
	}
	if s.connections.mcpRuntime != nil || len(s.connections.mcpTokens) != 0 {
		t.Fatal("successful removal retained preview or cached providers")
	}
	result, err = tools[0].Execute(context.Background(), json.RawMessage(`{"value":"after-removal"}`))
	if err == nil && !result.IsError {
		t.Fatal("successful removal did not close the old transport")
	}
}
