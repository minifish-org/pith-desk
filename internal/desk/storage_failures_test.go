package desk

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/minifish-org/pith-desk/internal/localstore"
	"github.com/minifish-org/pith-desk/internal/testsupport/filefault"
)

func TestStorageFailuresPreserveApplicationCommit(t *testing.T) {
	for _, stage := range []string{"write", "sync", "close", "rename"} {
		for _, operation := range []string{"appearance", "catalog", "read", "draft", "mcp", "notification"} {
			t.Run(stage+"/"+operation, func(t *testing.T) {
				s, dir, workspace := fixedPersistenceService(t)
				state := s.Snapshot()
				var err error
				path := ""
				switch operation {
				case "appearance":
					path = "settings.json"
				case "catalog", "read":
					path = "catalog.json"
				case "draft":
					path = "drafts/fixture-conversation.json"
				case "mcp":
					path = "mcp.json"
				case "notification":
					path = "notifications.json"
				}
				committed, err := os.ReadFile(filepath.Join(dir, path))
				if err != nil {
					t.Fatal(err)
				}
				oldMCP := s.ListMCP()
				s.files = localstore.Store{FS: &filefault.FS{Step: stage}}
				t.Cleanup(func() { s.files = localstore.Store{} })
				switch operation {
				case "appearance":
					err = s.SetAppearance(AppearanceLight)
				case "catalog":
					_, err = s.AddWorkspace(t.TempDir())
				case "read":
					err = s.MarkConversationRead("fixture-conversation", "fixture-run")
				case "draft":
					_, err = s.SaveDraft(DraftInput{DraftScope: DraftScope{ID: "fixture-conversation"}, Draft: Draft{Revision: 18, Text: "Uncommitted draft"}})
				case "mcp":
					err = s.SaveMCP(MCPInput{Name: "fixture-mcp", Type: "http", URL: "https://changed.example.invalid/api"})
				case "notification":
					err = s.ForgetCompletionNotification("pith-desk:completion:fixture-conversation:fixture-run")
				}
				if !errors.Is(err, filefault.ErrInjected) {
					t.Fatalf("failure was hidden: %v", err)
				}
				actual, err := os.ReadFile(filepath.Join(dir, path))
				if err != nil || !bytes.Equal(actual, committed) {
					t.Fatalf("failed operation replaced commit: %q, %v", actual, err)
				}
				if operation == "mcp" {
					// Existing cross-file behavior: endpoint changes invalidate old
					// OAuth state before mcp.json commits. Keep this explicit until
					// Connections owns a reviewed multi-file protocol (batch 5).
					oldMCP[0].SignedIn = false
					if _, err := os.Stat(s.mcpOAuthStore(s.mcpConfigs[0]).path); !errors.Is(err, os.ErrNotExist) {
						t.Fatalf("old endpoint auth invalidation changed: %v", err)
					}
				}
				if !reflect.DeepEqual(s.Snapshot(), state) || !reflect.DeepEqual(s.ListMCP(), oldMCP) {
					t.Fatal("failed save changed public state")
				}
				if s.config.Appearance != AppearanceDark {
					t.Fatal("failed save changed authoritative config")
				}
				if operation == "draft" {
					draft, err := s.Draft(DraftScope{ID: "fixture-conversation"})
					if err != nil || draft.Revision != 17 || draft.Text != "Fixture draft 中文" {
						t.Fatalf("failed draft advanced revision: %+v, %v", draft, err)
					}
				}
				// Root-relative cleanup and save paths must not touch user files.
				if _, err := os.Stat(workspace); err != nil {
					t.Fatalf("workspace changed: %v", err)
				}
			})
		}
	}
}

type failReceiptFS struct{ localstore.OS }

func (failReceiptFS) Rename(from, to string) error {
	if filepath.Base(filepath.Dir(to)) == "runs" {
		return filefault.ErrInjected
	}
	return os.Rename(from, to)
}

func TestStorageFailureAfterSettingsCommitRemainsPartialSuccess(t *testing.T) {
	s, dir, _ := fixedPersistenceService(t)
	s.active.Failure = &Failure{Kind: "credentials", CanContinue: false, Advice: "Original advice"}
	if err := writeJSON(s.receiptFile("fixture-conversation"), runReceipt{Runtime: s.active.Runtime, Failure: s.active.Failure}); err != nil {
		t.Fatal(err)
	}
	old, _ := os.ReadFile(s.receiptFile("fixture-conversation"))
	s.files = localstore.Store{FS: failReceiptFS{}}
	t.Cleanup(func() { s.files = localstore.Store{} })
	err := s.Configure(ConfigInput{Provider: "deepseek", BaseURL: "https://api.deepseek.com/v1", Model: "deepseek-flash", APIKey: "fixture-repaired-key"})
	if !errors.Is(err, filefault.ErrInjected) || !strings.Contains(err.Error(), "settings saved") {
		t.Fatalf("partial commit not reported: %v", err)
	}
	var settings savedConfig
	if err := readJSON(filepath.Join(dir, "settings.json"), &settings); err != nil || settings.APIKey != "fixture-repaired-key" || s.config.APIKey != settings.APIKey {
		t.Fatalf("settings commit lost: %+v, %v", settings, err)
	}
	actual, _ := os.ReadFile(s.receiptFile("fixture-conversation"))
	if !bytes.Equal(old, actual) || s.active.Failure.CanContinue || s.active.Failure.Advice != "Original advice" {
		t.Fatal("failed receipt overwritten or failure mutated")
	}
}
