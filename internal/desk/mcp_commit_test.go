package desk

import (
	"bytes"
	"context"
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

// Deleting a connection has its original, separately recorded partial-failure
// behavior. The authorized endpoint-change fix does not alter deletion flow.
func TestMCPRemovalFailureRetainsExistingPartialSuccess(t *testing.T) {
	s, dir, _ := fixedPersistenceService(t)
	config := s.connections.mcpConfigs[0]
	before, _ := os.ReadFile(filepath.Join(dir, "mcp.json"))
	s.files = localstore.Store{FS: &filefault.FS{Step: "rename"}}
	if err := s.RemoveMCP(config.Name); !errors.Is(err, filefault.ErrInjected) {
		t.Fatalf("failure: %v", err)
	}
	actual, _ := os.ReadFile(filepath.Join(dir, "mcp.json"))
	if !bytes.Equal(before, actual) || s.ListMCP()[0].SignedIn {
		t.Fatal("original removal failure semantics changed")
	}
	if _, err := os.Stat(s.mcpOAuthStore(config).path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("original auth deletion: %v", err)
	}
	s.files = localstore.Store{}
}
