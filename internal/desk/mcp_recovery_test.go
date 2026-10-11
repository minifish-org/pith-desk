package desk

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/minifish-org/pith-desk/internal/localstore"
	"github.com/minifish-org/pith/packages/mcp"
)

// After the real config commit, temporarily make its backup a nonempty
// directory: Remove fails on every platform, including tests running as root.
// Repair puts the untouched OAuth file back, reproducing the surviving backup
// from a permission or I/O cleanup failure without changing any fixed fixture.
type mcpCleanupBlocker struct {
	localstore.OS
	authDir, backup, held string
	armed                 bool
}

func (f *mcpCleanupBlocker) Rename(from, to string) error {
	if err := f.OS.Rename(from, to); err != nil {
		return err
	}
	if filepath.Base(to) != "mcp.json" || !f.armed {
		return nil
	}
	f.armed = false
	paths, err := filepath.Glob(filepath.Join(f.authDir, "*.pending-*"))
	if err != nil || len(paths) != 1 {
		return fmt.Errorf("cleanup window requires one backup: %v %v", paths, err)
	}
	f.backup, f.held = paths[0], paths[0]+".test-held"
	if err := os.Rename(f.backup, f.held); err != nil {
		return err
	}
	if err := os.Mkdir(f.backup, 0700); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(f.backup, "prevent-removal"), []byte("test cleanup failure"), 0600)
}

func (f *mcpCleanupBlocker) repair(t *testing.T) {
	t.Helper()
	for _, path := range []string{filepath.Join(f.backup, "prevent-removal"), f.backup} {
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Rename(f.held, f.backup); err != nil {
		t.Fatal(err)
	}
}

func mcpInput(config savedMCP) MCPInput {
	return MCPInput{Name: config.Name, Type: config.Type, URL: config.URL, OAuth: config.OAuth, OAuthClientID: config.OAuthClientID, OAuthScope: config.OAuthScope, Args: config.Args, Command: config.Command, Enabled: config.Enabled, BearerToken: config.BearerToken, Env: config.Env}
}

func assertMCPHasNoLogin(t *testing.T, s *Service, config savedMCP) {
	t.Helper()
	for _, view := range s.ListMCP() {
		if view.Name == config.Name && view.SignedIn {
			t.Fatal("deleted or invalidated OAuth was restored")
		}
	}
	if token, err := newMCPTokenProvider(config, s.mcpOAuthStore(config)).Token(context.Background()); err == nil || token != "" {
		t.Fatalf("deleted or invalidated token was accepted: %q %v", token, err)
	}
}

func TestMCPObsoleteBackupCannotSurviveConfigurationReuse(t *testing.T) {
	for _, change := range []string{"delete", "endpoint", "oauth", "client", "scope"} {
		for _, continuation := range []string{"same-process", "restart-before-reuse", "cleanup-still-blocked"} {
			t.Run(change+"/"+continuation, func(t *testing.T) {
				s, dir, _ := fixedPersistenceService(t)
				original := s.connections.mcpConfigs[0]
				input := mcpInput(original)
				blocker := &mcpCleanupBlocker{authDir: filepath.Dir(s.mcpOAuthStore(original).path), armed: true}
				s.files = localstore.Store{FS: blocker}
				var err error
				if change == "delete" {
					err = s.RemoveMCP(original.Name)
				} else {
					next := input
					switch change {
					case "endpoint":
						next.URL = "https://invalidated.example.invalid/mcp"
					case "oauth":
						next.OAuth = false
					case "client":
						next.OAuthClientID = "invalidated-client"
					case "scope":
						next.OAuthScope = "invalidated-scope"
					}
					err = s.SaveMCP(next)
				}
				if err == nil || !strings.Contains(err.Error(), "old OAuth cleanup failed") || blocker.backup == "" {
					t.Fatalf("did not reach committed cleanup failure: %v", err)
				}
				if change == "delete" && len(s.ListMCP()) != 0 {
					t.Fatal("removal was not committed before cleanup failed")
				}
				if continuation == "cleanup-still-blocked" {
					before, err := os.ReadFile(filepath.Join(dir, "mcp.json"))
					if err != nil {
						t.Fatal(err)
					}
					views := s.ListMCP()
					if err := s.SaveMCP(input); err == nil {
						t.Fatal("configuration reused an unresolved obsolete backup")
					}
					actual, err := os.ReadFile(filepath.Join(dir, "mcp.json"))
					if err != nil || !bytes.Equal(before, actual) || !reflect.DeepEqual(views, s.ListMCP()) {
						t.Fatal("failed backup reconciliation changed committed configuration")
					}
				}
				blocker.repair(t)
				s.files = localstore.Store{}
				if continuation == "restart-before-reuse" {
					s.Close()
					s, err = New(dir)
					if err != nil {
						t.Fatal(err)
					}
					t.Cleanup(s.Close)
				}
				if err := s.SaveMCP(input); err != nil {
					t.Fatal(err)
				}
				assertMCPHasNoLogin(t, s, original)
				s.Close()
				reopened, err := New(dir)
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(reopened.Close)
				assertMCPHasNoLogin(t, reopened, original)
				if _, err := os.Stat(blocker.backup); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("obsolete backup remains: %v", err)
				}
				// The guard must not poison future authorization or its persistence.
				expiry := time.Now().Add(time.Hour).UnixMilli()
				if err := reopened.mcpOAuthStore(original).Save(mcp.McpOAuthState{ServerURL: original.URL, Tokens: &mcp.OAuthTokens{AccessToken: "fresh-after-cleanup"}, TokensExpireAt: &expiry}); err != nil {
					t.Fatal(err)
				}
				reopened.Close()
				again, err := New(dir)
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(again.Close)
				if token, err := newMCPTokenProvider(original, again.mcpOAuthStore(original)).Token(context.Background()); err != nil || token != "fresh-after-cleanup" {
					t.Fatalf("fresh login did not survive recovery: %q %v", token, err)
				}
			})
		}
	}
}

func TestMCPBackupResolutionPreservesNewLogin(t *testing.T) {
	s, dir, _ := fixedPersistenceService(t)
	original := s.connections.mcpConfigs[0]
	input := mcpInput(original)
	input.OAuthScope = "new-scope"
	blocker := &mcpCleanupBlocker{authDir: filepath.Dir(s.mcpOAuthStore(original).path), armed: true}
	s.files = localstore.Store{FS: blocker}
	if err := s.SaveMCP(input); err == nil || !strings.Contains(err.Error(), "old OAuth cleanup failed") {
		t.Fatal(err)
	}
	blocker.repair(t)
	s.files = localstore.Store{}
	current := s.connections.mcpConfigs[0]
	expiry := time.Now().Add(time.Hour).UnixMilli()
	if err := s.mcpOAuthStore(current).Save(mcp.McpOAuthState{ServerURL: current.URL, Tokens: &mcp.OAuthTokens{AccessToken: "new-valid-login"}, TokensExpireAt: &expiry}); err != nil {
		t.Fatal(err)
	}
	input.Enabled = !input.Enabled
	if err := s.SaveMCP(input); err != nil {
		t.Fatal(err)
	}
	s.Close()
	reopened, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reopened.Close)
	if token, err := newMCPTokenProvider(current, reopened.mcpOAuthStore(current)).Token(context.Background()); err != nil || token != "new-valid-login" {
		t.Fatalf("reconciliation discarded a newer valid login: %q %v", token, err)
	}
}

func TestMCPLogoutResolvesUncommittedBackupBeforeDeletingLogin(t *testing.T) {
	s, dir, _ := fixedPersistenceService(t)
	config := s.connections.mcpConfigs[0]
	pending, err := s.connections.stageMCPAuth(config, s.files)
	if err != nil || pending == nil {
		t.Fatal(err)
	}
	// A failed rollback leaves a pending login matching the current config.
	if err := os.Mkdir(pending.path, 0700); err != nil {
		t.Fatal(err)
	}
	if err := pending.finish(false); err == nil {
		t.Fatal("rollback window did not fail")
	}
	if err := os.Remove(pending.path); err != nil {
		t.Fatal(err)
	}
	if err := s.LogoutMCPOAuth(config.Name); err != nil {
		t.Fatal(err)
	}
	s.Close()
	reopened, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reopened.Close)
	assertMCPHasNoLogin(t, reopened, config)
}

func TestMCPOAuthStartRejectsUnresolvedBackup(t *testing.T) {
	connector := newDeskMCPFixture(t, "", nil)
	s, _, _ := configuredService(t, "http://127.0.0.1:1")
	input := MCPInput{Name: "office", Type: "http", URL: connector.server.URL, OAuth: true}
	if err := s.SaveMCP(input); err != nil {
		t.Fatal(err)
	}
	config := s.connections.mcpConfigs[0]
	if err := s.mcpOAuthStore(config).Save(mcp.McpOAuthState{ServerURL: config.URL, Tokens: &mcp.OAuthTokens{AccessToken: "old-login"}}); err != nil {
		t.Fatal(err)
	}
	blocker := &mcpCleanupBlocker{authDir: filepath.Dir(s.mcpOAuthStore(config).path), armed: true}
	s.files = localstore.Store{FS: blocker}
	input.OAuthScope = "changed-scope"
	if err := s.SaveMCP(input); err == nil || !strings.Contains(err.Error(), "old OAuth cleanup failed") {
		t.Fatal(err)
	}
	if err := s.StartMCPOAuth(config.Name); err == nil || !strings.Contains(err.Error(), "pending backup") {
		t.Fatalf("started OAuth before resolving obsolete credentials: %v", err)
	}
	if s.Snapshot().Login != nil {
		t.Fatal("failed reconciliation opened the sign-in flow")
	}
}
