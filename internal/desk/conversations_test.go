package desk

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	agenttypes "github.com/minifish-org/pith/packages/agent/types"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
)

func productFeatureService(t *testing.T) (*Service, Workspace, Conversation, string) {
	t.Helper()
	base := t.TempDir()
	workspacePath, dataDir := filepath.Join(base, "workspace"), filepath.Join(base, "private")
	if err := os.Mkdir(workspacePath, 0755); err != nil {
		t.Fatal(err)
	}
	s, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	workspace, err := s.AddWorkspace(workspacePath)
	if err != nil {
		t.Fatal(err)
	}
	conversation, err := s.CreateConversation(workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	return s, workspace, conversation, dataDir
}

func appendFeatureMessage(t *testing.T, manager *codingagent.SessionManager, message aitypes.Message) {
	t.Helper()
	encoded, err := json.Marshal(agenttypes.NewAgentMessageFromMessage(message))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.AppendMessage(encoded); err != nil {
		t.Fatal(err)
	}
}

func TestConversationNamesArchivesAndExportsUsePithSession(t *testing.T) {
	s, workspace, conversation, dataDir := productFeatureService(t)
	if err := s.RenameConversation(conversation.ID, "  Notes\nfor tomorrow  "); err != nil {
		t.Fatal(err)
	}
	manager, err := codingagent.OpenSession(s.sessionFile(conversation.ID))
	if err != nil {
		t.Fatal(err)
	}
	if manager.GetCwd() != workspace.Path {
		t.Fatalf("wrong session cwd: %q", manager.GetCwd())
	}
	if latestSessionTitle(manager, "stale cache") != "Notes for tomorrow" {
		t.Fatal("rename was not stored in Pith")
	}
	appendFeatureMessage(t, manager, aitypes.NewUserMessageVariant(aitypes.NewUserMessage("Make a note.", 1)))
	assistant := aitypes.NewAssistantMessage(aitypes.ApiOpenAICompletions, "fixture", "offline", 2)
	assistant.StopReason, assistant.Content = aitypes.StopReasonStop, []aitypes.ContentBlock{aitypes.TextBlock("Your note is ready.")}
	appendFeatureMessage(t, manager, aitypes.NewAssistantMessageVariant(assistant))
	appendFeatureMessage(t, manager, aitypes.NewToolResultMessageVariant(aitypes.NewToolResultMessage("call", "write_file", []aitypes.ContentBlock{aitypes.TextBlock("Output with ``` inside")}, false, 3)))
	manager.Close()
	if err := s.ArchiveConversation(conversation.ID, true); err != nil {
		t.Fatal(err)
	}
	if !s.Snapshot().Conversations[0].Archived || s.Snapshot().ActiveID != conversation.ID {
		t.Fatal("archive lost the readable active conversation")
	}
	exported, err := s.ExportConversation(conversation.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"# Notes for tomorrow", "## You", "Make a note.", "## Pith", "Your note is ready.", "## Tool: write_file", "````text"} {
		if !strings.Contains(exported, expected) {
			t.Fatalf("export missing %q: %s", expected, exported)
		}
	}
	s.Close()
	reopened, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if !reopened.Snapshot().Conversations[0].Archived {
		t.Fatal("archive did not survive restart")
	}
	if err := reopened.ArchiveConversation(conversation.ID, false); err != nil {
		t.Fatal(err)
	}
	if reopened.Snapshot().Conversations[0].Archived {
		t.Fatal("restore failed")
	}
}

func TestEmptyHistoricalConversationExportDoesNotCreateSession(t *testing.T) {
	s, workspace, conversation, _ := productFeatureService(t)
	exported, err := s.ExportConversation(conversation.ID)
	if err != nil || !strings.Contains(exported, "# New conversation") {
		t.Fatalf("empty export: %q %v", exported, err)
	}
	if _, err := os.Stat(s.sessionFile(conversation.ID)); !os.IsNotExist(err) {
		t.Fatal("export created a session")
	}
	if err := os.MkdirAll(filepath.Dir(s.sessionFile(conversation.ID)), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(s.sessionFile(conversation.ID), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ExportConversation(conversation.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.OpenConversation(conversation.ID); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(s.sessionFile(conversation.ID))
	if info.Size() != 0 {
		t.Fatal("export rewrote a historical empty session")
	}
	if err := s.RenameConversation(conversation.ID, "Empty but named"); err != nil {
		t.Fatal(err)
	}
	manager, err := codingagent.OpenSession(s.sessionFile(conversation.ID))
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	if manager.Header().Cwd != workspace.Path {
		t.Fatal("viewing an empty historical conversation lost its workspace")
	}
	if err := s.RenameConversation(conversation.ID, "\n "); err == nil {
		t.Fatal("empty name accepted")
	}
}

func TestCanonicalRenameSurvivesCatalogSaveFailure(t *testing.T) {
	s, _, conversation, dataDir := productFeatureService(t)
	other, err := s.CreateConversation(conversation.WorkspaceID)
	if err != nil {
		t.Fatal(err)
	}
	catalogPath := filepath.Join(dataDir, "catalog.json")
	oldCatalog, err := os.ReadFile(catalogPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(catalogPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(catalogPath, 0700); err != nil {
		t.Fatal(err)
	}
	if err := s.RenameConversation(conversation.ID, "Canonical rename"); err == nil {
		t.Fatal("catalog save failure was hidden")
	}
	if err := os.Remove(catalogPath); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(catalogPath, oldCatalog, 0600); err != nil {
		t.Fatal(err)
	}
	s.Close()
	reopened, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if reopened.Snapshot().Conversations[0].Title != "Canonical rename" {
		t.Fatal("restart let the stale catalog override Pith's canonical title")
	}
	if reopened.Snapshot().ActiveID != other.ID {
		t.Fatal("title reconciliation switched the active conversation")
	}
}

func TestConversationOperationsRejectActiveRun(t *testing.T) {
	s, _, conversation, _ := productFeatureService(t)
	s.mu.Lock()
	s.state.Running = true
	s.mu.Unlock()
	if err := s.RenameConversation(conversation.ID, "blocked"); err == nil {
		t.Fatal("rename during run accepted")
	}
	if err := s.ArchiveConversation(conversation.ID, true); err == nil {
		t.Fatal("archive during run accepted")
	}
	if _, err := s.ExportConversation(conversation.ID); err == nil {
		t.Fatal("export during run accepted")
	}
	s.mu.Lock()
	s.state.Running = false
	s.mu.Unlock()
}
