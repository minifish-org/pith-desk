package desk

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	aitypes "github.com/minifish-org/pith/packages/ai/types"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
)

func recordFeatureArtifact(t *testing.T, manager *codingagent.SessionManager, id, name, path string, failed bool) {
	t.Helper()
	args, _ := json.Marshal(map[string]string{"path": path})
	call := aitypes.NewToolCall(id, name, args)
	assistant := aitypes.NewAssistantMessage(aitypes.ApiOpenAICompletions, "fixture", "offline", 1)
	assistant.StopReason, assistant.Content = aitypes.StopReasonToolUse, []aitypes.ContentBlock{aitypes.ToolCallBlock(call)}
	appendFeatureMessage(t, manager, aitypes.NewAssistantMessageVariant(assistant))
	appendFeatureMessage(t, manager, aitypes.NewToolResultMessageVariant(aitypes.NewToolResultMessage(id, name, []aitypes.ContentBlock{aitypes.TextBlock("fixture result")}, failed, 2)))
}

func TestArtifactsRequireSuccessfulOriginalCallsAndCurrentWorkspaceFiles(t *testing.T) {
	s, workspace, conversation, dataDir := productFeatureService(t)
	for _, name := range []string{"good.txt", "failed.txt", "replayed.txt", "unrelated.txt"} {
		if err := os.WriteFile(filepath.Join(workspace.Path, name), []byte(name), 0644); err != nil {
			t.Fatal(err)
		}
	}
	outside := filepath.Join(filepath.Dir(workspace.Path), "outside.txt")
	if err := os.WriteFile(outside, []byte("outside"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(workspace.Path, "external-link.txt")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	privateFile := filepath.Join(dataDir, "private.txt")
	if err := os.WriteFile(privateFile, []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(privateFile, filepath.Join(workspace.Path, "private-link.txt")); err != nil {
		t.Fatal(err)
	}
	manager, err := openDeskSession(s.sessionFile(conversation.ID), conversation.ID, workspace.Path)
	if err != nil {
		t.Fatal(err)
	}
	recordFeatureArtifact(t, manager, "good", "write_file", "good.txt", false)
	recordFeatureArtifact(t, manager, "edit", "edit_file", "good.txt", false)
	recordFeatureArtifact(t, manager, "failed", "write_file", "failed.txt", true)
	recordFeatureArtifact(t, manager, "replayed", "write_file", "replayed.txt", false)
	appendFeatureMessage(t, manager, aitypes.NewToolResultMessageVariant(aitypes.NewToolResultMessage("replayed", "write_file", nil, false, 3)))
	recordFeatureArtifact(t, manager, "missing", "write_file", "missing.txt", false)
	recordFeatureArtifact(t, manager, "external", "write_file", "external-link.txt", false)
	recordFeatureArtifact(t, manager, "private", "write_file", "private-link.txt", false)
	recordFeatureArtifact(t, manager, "outside", "write_file", outside, false)
	recordFeatureArtifact(t, manager, "read", "read_file", "unrelated.txt", false)
	manager.Close()
	artifacts, err := s.Artifacts(conversation.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(artifacts) != 1 || artifacts[0].Name != "good.txt" {
		t.Fatalf("unverified artifacts: %+v", artifacts)
	}
	if path, err := s.ResolveArtifactFile(conversation.ID, artifacts[0].Path); err != nil || path != artifacts[0].Path {
		t.Fatalf("recorded file not openable: %q %v", path, err)
	}
	if _, err := s.ResolveArtifactFile(conversation.ID, filepath.Join(workspace.Path, "unrelated.txt")); err == nil {
		t.Fatal("arbitrary file was openable")
	}
	if err := os.Remove(artifacts[0].Path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, artifacts[0].Path); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ResolveArtifactFile(conversation.ID, artifacts[0].Path); err == nil {
		t.Fatal("artifact switched to an external symlink remained openable")
	}
}

func TestArtifactsUseOnlyActivePithBranch(t *testing.T) {
	s, workspace, conversation, _ := productFeatureService(t)
	for _, name := range []string{"active.txt", "abandoned.txt"} {
		if err := os.WriteFile(filepath.Join(workspace.Path, name), []byte(name), 0644); err != nil {
			t.Fatal(err)
		}
	}
	manager, err := openDeskSession(s.sessionFile(conversation.ID), conversation.ID, workspace.Path)
	if err != nil {
		t.Fatal(err)
	}
	recordFeatureArtifact(t, manager, "active", "write_file", "active.txt", false)
	leaf := manager.LeafID()
	recordFeatureArtifact(t, manager, "abandoned", "write_file", "abandoned.txt", false)
	if err := manager.Branch(leaf); err != nil {
		t.Fatal(err)
	}
	manager.Close()
	artifacts, err := s.Artifacts(conversation.ID)
	if err != nil || len(artifacts) != 1 || artifacts[0].Name != "active.txt" {
		t.Fatalf("branch artifacts: %+v %v", artifacts, err)
	}
	s.mu.Lock()
	s.active.Running = true
	s.mu.Unlock()
	if _, err := s.Artifacts(conversation.ID); err == nil {
		t.Fatal("artifact inspection during run accepted")
	}
	s.mu.Lock()
	s.active.Running = false
	s.mu.Unlock()
}
