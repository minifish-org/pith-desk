package desk

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	authtypes "github.com/minifish-org/pith/packages/ai/auth/types"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
	"github.com/minifish-org/pith/packages/durable"
	"github.com/minifish-org/pith/packages/durable/storage/jsonl"
	"github.com/minifish-org/pith/packages/mcp"
)

func persistenceFixture(t *testing.T, name, workspace string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "persistence", name))
	if err != nil {
		t.Fatal(err)
	}
	if workspace != "" {
		encoded, err := json.Marshal(workspace)
		if err != nil {
			t.Fatal(err)
		}
		data = bytes.ReplaceAll(data, []byte(`"__WORKSPACE__"`), encoded)
	}
	return data
}

func installPersistenceFixture(t *testing.T, dir, name, destination, workspace string) {
	t.Helper()
	path := filepath.Join(dir, destination)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, persistenceFixture(t, name, workspace), 0600); err != nil {
		t.Fatal(err)
	}
}

func assertJSONMeaning(t *testing.T, actual, expected []byte) {
	t.Helper()
	var a, e any
	if err := json.Unmarshal(actual, &a); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(expected, &e); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(a, e) {
		t.Fatalf("JSON contract changed:\nactual: %s\nfixture: %s", actual, expected)
	}
}

func TestPersistenceFixedJSONShapes(t *testing.T) {
	for _, entry := range []struct {
		name   string
		target any
	}{
		{"settings.json", &savedConfig{}}, {"mcp.json", &[]savedMCP{}},
		{"mcp-auth.json", &mcp.McpOAuthState{}}, {"catalog.json", &catalogState{}},
		{"run.json", &runReceipt{}}, {"draft.json", &Draft{}},
		{"pending-deletions.json", &[]string{}}, {"notifications.json", &completionNotificationLedger{}},
		{"costs.jsonl", &RequestCost{}},
	} {
		t.Run(entry.name, func(t *testing.T) {
			data := persistenceFixture(t, entry.name, t.TempDir())
			if err := json.Unmarshal(data, entry.target); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(t.TempDir(), entry.name)
			if err := writeJSON(path, entry.target); err != nil {
				t.Fatal(err)
			}
			written, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			assertJSONMeaning(t, written, data)
		})
	}
}

func fixedPersistenceService(t *testing.T) (*Service, string, string) {
	t.Helper()
	dir, workspace := t.TempDir(), t.TempDir()
	for _, entry := range []struct{ name, destination string }{
		{"settings.json", "settings.json"}, {"auth.json", "auth.json"},
		{"mcp.json", "mcp.json"}, {"catalog.json", "catalog.json"},
		{"session.jsonl", "sessions/fixture-conversation.jsonl"},
		{"run.json", "runs/fixture-conversation.json"}, {"costs.jsonl", "costs/fixture-conversation.jsonl"},
		{"draft.json", "drafts/fixture-conversation.json"}, {"draft.json", "drafts/workspace-fixture-workspace.json"},
		{"notifications.json", "notifications.json"},
	} {
		installPersistenceFixture(t, dir, entry.name, entry.destination, workspace)
	}
	s, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	authPath, err := filepath.Rel(s.dataDir, s.mcpOAuthStore(s.mcpConfigs[0]).path)
	if err != nil {
		t.Fatal(err)
	}
	installPersistenceFixture(t, dir, "mcp-auth.json", authPath, workspace)
	return s, dir, workspace
}

func TestPersistenceServiceRestoresFixedData(t *testing.T) {
	s, dir, _ := fixedPersistenceService(t)
	state := s.Snapshot()
	if state.ActiveID != "fixture-conversation" || state.Conversations[0].Title != "Session title" || state.Conversations[0].PermissionMode != PermissionWorkspaceWrite || !state.Conversations[0].Unread || state.Conversations[0].CompletedRunID != "fixture-run" {
		t.Fatalf("catalog/session authority: %+v", state.Conversations)
	}
	if state.Error != "" || len(state.Messages) != 1 || state.Messages[0].Text != "Fixture history" || state.Runtime.Phase != "complete" || state.Runtime.Timing.ElapsedMs != 1500 {
		t.Fatalf("restored state: %+v", state)
	}
	report, err := s.Costs(state.ActiveID)
	if err != nil || report.Total != 0.25 || report.RunTotal != 0.25 || report.RequestCount != 1 || report.RunRequests != 1 {
		t.Fatalf("ledger authority: %+v, %v", report, err)
	}
	for _, scope := range []DraftScope{{ID: state.ActiveID}, {WorkspaceID: "fixture-workspace"}} {
		draft, err := s.Draft(scope)
		if err != nil || draft.Revision != 17 || draft.Text != "Fixture draft 中文" || len(draft.Images) != 1 {
			t.Fatalf("scoped draft: %+v, %v", draft, err)
		}
	}
	views := s.ListMCP()
	if len(views) != 1 || !views[0].SignedIn || !views[0].HasBearerToken || !reflect.DeepEqual(views[0].EnvKeys, []string{"FIXTURE_ENV"}) {
		t.Fatalf("MCP persisted configuration: %+v", views)
	}
	store := s.mcpOAuthStore(s.mcpConfigs[0])
	auth, err := store.Load()
	if err != nil || auth.Tokens.RefreshToken != "fixture-refresh" {
		t.Fatalf("MCP auth: %+v, %v", auth, err)
	}
	if err := store.Save(*auth); err != nil {
		t.Fatal(err)
	}
	written, err := os.ReadFile(store.path)
	if err != nil {
		t.Fatal(err)
	}
	assertJSONMeaning(t, written, persistenceFixture(t, "mcp-auth.json", ""))
	ledger, err := s.readCompletionNotificationsLocked()
	if err != nil || ledger.Version != 1 || len(ledger.Entries) != 1 || !s.validCompletionNotificationLocked(ledger.Entries[0], time.Date(2026, 10, 2, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("notifications: %+v, %v", ledger, err)
	}
	if err := s.SetAppearance(AppearanceLight); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SaveDraft(DraftInput{DraftScope: DraftScope{ID: state.ActiveID}, Draft: Draft{Revision: 18}}); err != nil {
		t.Fatal(err)
	}
	s.Close()
	reopened, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	draft, err := reopened.Draft(DraftScope{ID: state.ActiveID})
	if err != nil || draft.Revision != 18 || draft.Text != "" || len(draft.Images) != 0 || reopened.Snapshot().Settings.Appearance != AppearanceLight {
		t.Fatalf("write-back/restart: %+v, %v", draft, err)
	}
	workspaceDraft, err := reopened.Draft(DraftScope{WorkspaceID: "fixture-workspace"})
	if err != nil || workspaceDraft.Revision != 17 {
		t.Fatalf("workspace draft changed: %+v, %v", workspaceDraft, err)
	}
}

func TestPersistenceLegacySettingsAndSDKAuth(t *testing.T) {
	dir := t.TempDir()
	installPersistenceFixture(t, dir, "settings.legacy.json", "settings.json", "")
	installPersistenceFixture(t, dir, "auth.json", "auth.json", "")
	s, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if s.config.Provider != "deepseek" || s.config.ThinkingLevel != "high" || s.config.Appearance != AppearanceSystem || s.config.Connections["deepseek"].APIKey != "fixture-legacy-key" {
		t.Fatalf("legacy migration: %+v", s.config)
	}
	if err := s.SetAppearance(AppearanceDark); err != nil {
		t.Fatal(err)
	}
	var saved savedConfig
	if err := readJSON(filepath.Join(dir, "settings.json"), &saved); err != nil || saved.AuthPath != "" || saved.APIKey != "fixture-legacy-key" {
		t.Fatalf("legacy write-back: %+v, %v", saved, err)
	}
	storage := codingagent.CreateAuthStorage(filepath.Join(dir, "auth.json"))
	credential, err := storage.Read(context.Background(), "deepseek", nil)
	key, ok := credential.(*authtypes.ApiKeyCredential)
	if err != nil || !ok || key.Key == nil || *key.Key != "fixture-auth-key" {
		t.Fatalf("SDK credential reader: %+v, %v", credential, err)
	}
	if _, err := storage.Modify(context.Background(), "deepseek", func(current authtypes.Credential) (authtypes.Credential, error) { return current, nil }, nil); err != nil {
		t.Fatal(err)
	}
	written, err := os.ReadFile(filepath.Join(dir, "auth.json"))
	if err != nil {
		t.Fatal(err)
	}
	assertJSONMeaning(t, written, persistenceFixture(t, "auth.json", ""))
}

func TestPersistenceMissingCorruptAndTemporaryFiles(t *testing.T) {
	t.Run("missing and temporary", func(t *testing.T) {
		dir := t.TempDir()
		installPersistenceFixture(t, dir, "settings.json", ".save-orphan", "")
		s, err := New(dir)
		if err != nil {
			t.Fatal(err)
		}
		defer s.Close()
		if s.Snapshot().Settings.Appearance != AppearanceSystem || len(s.Snapshot().Conversations) != 0 {
			t.Fatal("orphan temp file became authoritative")
		}
		draft, err := readDraft(filepath.Join(dir, "absent.json"))
		if err != nil || draft.Revision != 0 {
			t.Fatalf("missing draft: %+v, %v", draft, err)
		}
		ledger, err := s.readCompletionNotificationsLocked()
		if err != nil || ledger.Version != 1 {
			t.Fatalf("missing notification default: %+v, %v", ledger, err)
		}
		state, err := s.mcpOAuthStore(savedMCP{Name: "absent"}).Load()
		if err != nil || state != nil {
			t.Fatalf("missing MCP auth: %+v, %v", state, err)
		}
	})
	for _, file := range []string{"settings.json", "mcp.json", "catalog.json", "pending-deletions.json"} {
		t.Run(file, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, file), []byte("{broken"), 0600); err != nil {
				t.Fatal(err)
			}
			if s, err := New(dir); err == nil {
				s.Close()
				t.Fatal("corrupt data silently reset")
			}
			data, _ := os.ReadFile(filepath.Join(dir, file))
			if string(data) != "{broken" {
				t.Fatal("corrupt authority overwritten")
			}
		})
	}
	for _, file := range []string{"runs/fixture-conversation.json", "costs/fixture-conversation.jsonl", "drafts/fixture-conversation.json", "notifications.json"} {
		t.Run(file, func(t *testing.T) {
			s, dir, _ := fixedPersistenceService(t)
			path := filepath.Join(dir, file)
			if err := os.WriteFile(path, []byte("{broken"), 0600); err != nil {
				t.Fatal(err)
			}
			switch {
			case strings.HasPrefix(file, "runs/"):
				if err := s.OpenConversation("fixture-conversation"); err == nil {
					t.Fatal("corrupt receipt ignored")
				}
			case strings.HasPrefix(file, "costs/"):
				if _, err := s.Costs("fixture-conversation"); err == nil {
					t.Fatal("corrupt cost treated as zero")
				}
				if err := s.OpenConversation("fixture-conversation"); err != nil || !s.Snapshot().Runtime.Cost.Unavailable {
					t.Fatalf("history unavailable instead of cost: %v", err)
				}
			case strings.HasPrefix(file, "drafts/"):
				if _, err := s.Draft(DraftScope{ID: "fixture-conversation"}); err == nil {
					t.Fatal("corrupt draft ignored")
				}
			default:
				if _, err := s.readCompletionNotificationsLocked(); err == nil {
					t.Fatal("corrupt notification ledger ignored")
				}
			}
		})
	}
	for _, version := range []string{`{"version":2,"entries":[]}`, `{"version":null,"entries":[]}`} {
		s, dir, _ := fixedPersistenceService(t)
		if err := os.WriteFile(filepath.Join(dir, "notifications.json"), []byte(version), 0600); err != nil {
			t.Fatal(err)
		}
		_, err := s.readCompletionNotificationsLocked()
		if strings.Contains(version, "2") && err == nil {
			t.Fatal("unsupported notification version accepted")
		}
		// null keeps the reader's initialized v1; preserve this existing rule.
		if strings.Contains(version, "null") && err != nil {
			t.Fatalf("changed null-version default: %v", err)
		}
	}
}

func TestPersistenceLegacyCatalogAndAuthErrors(t *testing.T) {
	dir, workspace := t.TempDir(), t.TempDir()
	installPersistenceFixture(t, dir, "catalog.legacy.json", "catalog.json", workspace)
	installPersistenceFixture(t, dir, "session.jsonl", "sessions/fixture-conversation.jsonl", workspace)
	s, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	entry := s.Snapshot().Conversations[0]
	if entry.PermissionMode != PermissionAsk || entry.Unread || entry.CompletedRunID != "" || entry.Title != "Session title" {
		t.Fatalf("legacy catalog defaults/authority: %+v", entry)
	}
	var written catalogState
	if err := readJSON(filepath.Join(dir, "catalog.json"), &written); err != nil || written.Conversations[0].PermissionMode != PermissionAsk {
		t.Fatalf("normalized catalog write-back: %+v, %v", written, err)
	}
	for _, file := range []string{"auth.json", "mcp-auth.json"} {
		t.Run(file, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), file)
			if err := os.WriteFile(path, []byte("{broken"), 0600); err != nil {
				t.Fatal(err)
			}
			if file == "auth.json" {
				if _, err := codingagent.CreateAuthStorage(path).Read(context.Background(), "deepseek", nil); err == nil {
					t.Fatal("corrupt SDK auth ignored")
				}
			} else if _, err := (mcpOAuthFile{path: path}).Load(); err == nil {
				t.Fatal("corrupt MCP OAuth ignored")
			}
			data, err := os.ReadFile(path)
			if err != nil || string(data) != "{broken" {
				t.Fatalf("corrupt credentials overwritten: %q, %v", data, err)
			}
		})
	}
}

func TestPersistenceSessionVersionAndTail(t *testing.T) {
	for _, mode := range []string{"valid", "incomplete tail", "bad complete record", "version 2", "missing version"} {
		t.Run(mode, func(t *testing.T) {
			data := persistenceFixture(t, "session.jsonl", t.TempDir())
			switch mode {
			case "incomplete tail":
				data = append(data, []byte(`{"type":"message"`)...)
			case "bad complete record":
				data = append(data, []byte("broken\n")...)
			case "version 2":
				data = bytes.Replace(data, []byte(`"version":3`), []byte(`"version":2`), 1)
			case "missing version":
				data = bytes.Replace(data, []byte(`"version":3,`), nil, 1)
			}
			path := filepath.Join(t.TempDir(), "session.jsonl")
			if err := os.WriteFile(path, data, 0600); err != nil {
				t.Fatal(err)
			}
			manager, err := codingagent.OpenSession(path)
			if mode == "bad complete record" || strings.Contains(mode, "version") {
				if err == nil {
					manager.Close()
					t.Fatal("unsupported/corrupt session accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if len(messagesFrom(manager)) != 1 || latestSessionTitle(manager, "") != "Session title" {
				t.Fatal("committed transcript not recovered")
			}
			if _, err := manager.AppendSessionInfo("Written title"); err != nil {
				t.Fatal(err)
			}
			if err := manager.Close(); err != nil {
				t.Fatal(err)
			}
			manager, err = codingagent.OpenSession(path)
			if err != nil {
				t.Fatal(err)
			}
			defer manager.Close()
			if latestSessionTitle(manager, "") != "Written title" || len(messagesFrom(manager)) != 1 {
				t.Fatal("tail repair/write-back lost transcript")
			}
		})
	}
}

func TestPersistenceDurableFixedCommitAndRecovery(t *testing.T) {
	for _, mode := range []string{"valid", "incomplete main tail", "unconfirmed sidecar", "unsupported format", "missing sidecar", "corrupt sidecar"} {
		t.Run(mode, func(t *testing.T) {
			dir := t.TempDir()
			for _, file := range []string{"main.jsonl", "task-1.jsonl", "doc-2.jsonl"} {
				installPersistenceFixture(t, dir, "durable/"+file, file, "")
			}
			switch mode {
			case "incomplete main tail":
				file, err := os.OpenFile(filepath.Join(dir, "main.jsonl"), os.O_APPEND|os.O_WRONLY, 0600)
				if err != nil {
					t.Fatal(err)
				}
				_, err = file.WriteString(`{"format":1`)
				file.Close()
				if err != nil {
					t.Fatal(err)
				}
			case "unconfirmed sidecar":
				data := persistenceFixture(t, "durable/task-1.jsonl", "")
				data = bytes.Replace(data, []byte(`"seq":1`), []byte(`"seq":2`), 1)
				data = bytes.Replace(data, []byte("Never replay this fixture"), []byte("Uncommitted request"), 1)
				file, err := os.OpenFile(filepath.Join(dir, "task-1.jsonl"), os.O_APPEND|os.O_WRONLY, 0600)
				if err != nil {
					t.Fatal(err)
				}
				_, err = file.Write(data)
				file.Close()
				if err != nil {
					t.Fatal(err)
				}
			case "unsupported format":
				data := bytes.Replace(persistenceFixture(t, "durable/main.jsonl", ""), []byte(`"format":1`), []byte(`"format":2`), 1)
				if err := os.WriteFile(filepath.Join(dir, "main.jsonl"), data, 0600); err != nil {
					t.Fatal(err)
				}
			case "missing sidecar":
				if err := os.Remove(filepath.Join(dir, "task-1.jsonl")); err != nil {
					t.Fatal(err)
				}
			case "corrupt sidecar":
				if err := os.WriteFile(filepath.Join(dir, "task-1.jsonl"), []byte("broken\n"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			storage, err := jsonl.Open(context.Background(), dir, jsonl.Options{Fsync: true})
			if mode == "unsupported format" || mode == "missing sidecar" || mode == "corrupt sidecar" {
				if err == nil {
					storage.Close(context.Background())
					t.Fatal("corrupt confirmed journal accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			defer storage.Close(context.Background())
			tasks, err := storage.ScanTasks(context.Background(), durable.TaskQuery{}, 10, nil)
			if err != nil || len(tasks.Items) != 1 || !strings.Contains(string(tasks.Items[0].Input), "Never replay this fixture") {
				t.Fatalf("commit marker authority: %+v, %v", tasks, err)
			}
			document, err := storage.Document(context.Background(), 2, durable.CurrentDocument())
			if err != nil || document == nil || document.Value["text"] != "Fixture document" {
				t.Fatalf("document sidecar recovery: %+v, %v", document, err)
			}
			// Read/rewrite an actual task through the pinned storage API.
			task := tasks.Items[0]
			task.State = durable.TaskState{Status: durable.TaskStatusTerminal, Outcome: &durable.TaskOutcome{Status: durable.OutcomeAborted}}
			if _, err := storage.Commit(context.Background(), []durable.StorageWrite{{Type: durable.WriteTask, Task: &task}}); err != nil {
				t.Fatal(err)
			}
			if err := storage.Close(context.Background()); err != nil {
				t.Fatal(err)
			}
			storage, err = jsonl.Open(context.Background(), dir, jsonl.Options{Fsync: true})
			if err != nil {
				t.Fatal(err)
			}
			defer storage.Close(context.Background())
			tasks, err = storage.ScanTasks(context.Background(), durable.TaskQuery{}, 10, nil)
			if err != nil || tasks.Items[0].State.Status != durable.TaskStatusTerminal {
				t.Fatalf("durable write-back: %+v, %v", tasks, err)
			}
		})
	}
}

func TestPersistenceDeletionIntentUsesCommittedCatalog(t *testing.T) {
	for _, committed := range []bool{false, true} {
		t.Run(map[bool]string{false: "uncommitted", true: "committed"}[committed], func(t *testing.T) {
			s, dir, _ := fixedPersistenceService(t)
			s.Close()
			installPersistenceFixture(t, dir, "pending-deletions.json", "pending-deletions.json", "")
			if committed {
				if err := writeJSON(filepath.Join(dir, "catalog.json"), catalogState{Workspaces: s.state.Workspaces, Conversations: []Conversation{}}); err != nil {
					t.Fatal(err)
				}
			}
			reopened, err := New(dir)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			_, err = os.Stat(filepath.Join(dir, "sessions/fixture-conversation.jsonl"))
			if committed && !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("committed deletion not cleaned: %v", err)
			}
			if !committed && err != nil {
				t.Fatalf("uncommitted deletion removed transcript: %v", err)
			}
			if _, err := os.Stat(filepath.Join(dir, "pending-deletions.json")); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("intent not cleared: %v", err)
			}
		})
	}
}
