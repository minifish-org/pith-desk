package desk

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	aitypes "github.com/minifish-org/pith/packages/ai/types"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
)

func recordFeatureArtifact(t *testing.T, manager *codingagent.SessionManager, id, name, path string, failed bool) {
	t.Helper()
	recordFeatureArtifactDetails(t, manager, id, name, path, failed, nil)
}

func recordFeatureArtifactDetails(t *testing.T, manager *codingagent.SessionManager, id, name, path string, failed bool, details json.RawMessage) {
	t.Helper()
	args, _ := json.Marshal(map[string]string{"path": path})
	call := aitypes.NewToolCall(id, name, args)
	assistant := aitypes.NewAssistantMessage(aitypes.ApiOpenAICompletions, "fixture", "offline", 1)
	assistant.StopReason, assistant.Content = aitypes.StopReasonToolUse, []aitypes.ContentBlock{aitypes.ToolCallBlock(call)}
	appendFeatureMessage(t, manager, aitypes.NewAssistantMessageVariant(assistant))
	result := aitypes.NewToolResultMessage(id, name, []aitypes.ContentBlock{aitypes.TextBlock("fixture result")}, failed, 2)
	result.Details = details
	appendFeatureMessage(t, manager, aitypes.NewToolResultMessageVariant(result))
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

func TestArtifactsSumLineChangesFromSuccessfulWritesAndEdits(t *testing.T) {
	s, workspace, conversation, _ := productFeatureService(t)
	for _, name := range []string{"sum.txt", "legacy.txt"} {
		if err := os.WriteFile(filepath.Join(workspace.Path, name), []byte(name), 0644); err != nil {
			t.Fatal(err)
		}
	}
	manager, err := openDeskSession(s.sessionFile(conversation.ID), conversation.ID, workspace.Path)
	if err != nil {
		t.Fatal(err)
	}
	recordFeatureArtifactDetails(t, manager, "write", "write_file", "sum.txt", false, json.RawMessage(`{"additions":3,"deletions":1}`))
	recordFeatureArtifactDetails(t, manager, "edit", "edit_file", "sum.txt", false, json.RawMessage(`{"patch":"--- a/sum.txt\n+++ b/sum.txt\n@@ -1,2 +1,3 @@\n-one\n+changed\n+more\n two\n"}`))
	recordFeatureArtifactDetails(t, manager, "failed", "edit_file", "sum.txt", true, json.RawMessage(`{"patch":"+ignored\n"}`))
	recordFeatureArtifact(t, manager, "legacy", "write_file", "legacy.txt", false)
	manager.Close()
	artifacts, err := s.Artifacts(conversation.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(artifacts) != 2 || artifacts[0].Name != "sum.txt" || artifacts[1].Name != "legacy.txt" {
		t.Fatalf("artifact order: %+v", artifacts)
	}
	if artifacts[0].Additions != 5 || artifacts[0].Deletions != 2 {
		t.Fatalf("change totals: %+v", artifacts[0])
	}
	if artifacts[1].Additions != 0 || artifacts[1].Deletions != 0 {
		t.Fatalf("legacy artifact gained a summary: %+v", artifacts[1])
	}
}

func TestArtifactDiffKeepsOriginalSuccessfulChanges(t *testing.T) {
	s, workspace, conversation, _ := productFeatureService(t)
	for _, name := range []string{"sum.txt", "legacy.txt"} {
		if err := os.WriteFile(filepath.Join(workspace.Path, name), []byte(name), 0644); err != nil {
			t.Fatal(err)
		}
	}
	manager, err := openDeskSession(s.sessionFile(conversation.ID), conversation.ID, workspace.Path)
	if err != nil {
		t.Fatal(err)
	}
	writeDetails, _ := json.Marshal(map[string]any{
		"additions": 2, "deletions": 0,
		"patch": "--- a/sum.txt\n+++ b/sum.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n",
	})
	editDetails, _ := json.Marshal(map[string]any{
		"patch": "--- a/sum.txt\n+++ b/sum.txt\n@@ -1,2 +1,2 @@\n-one\n+ONE\n two\n",
	})
	failedDetails, _ := json.Marshal(map[string]any{"patch": "--- a/sum.txt\n+++ b/sum.txt\n@@ -1 +1 @@\n-ignored\n+ignored\n"})
	recordFeatureArtifactDetails(t, manager, "write", "write_file", "sum.txt", false, writeDetails)
	recordFeatureArtifactDetails(t, manager, "edit", "edit_file", "sum.txt", false, editDetails)
	recordFeatureArtifactDetails(t, manager, "failed", "edit_file", "sum.txt", true, failedDetails)
	recordFeatureArtifact(t, manager, "legacy", "write_file", "legacy.txt", false)
	manager.Close()
	artifacts, err := s.Artifacts(conversation.ID)
	if err != nil {
		t.Fatal(err)
	}
	paths := map[string]string{}
	for _, artifact := range artifacts {
		paths[artifact.Name] = artifact.Path
	}
	diff, err := s.DiffArtifact(conversation.ID, paths["sum.txt"])
	if err != nil {
		t.Fatal(err)
	}
	if len(diff.Changes) != 2 {
		t.Fatalf("diff changes: %+v", diff)
	}
	if !strings.Contains(diff.Changes[0].Patch, "+one") || diff.Changes[0].Additions != 2 || diff.Changes[0].Deletions != 0 {
		t.Fatalf("write change: %+v", diff.Changes[0])
	}
	if !strings.Contains(diff.Changes[1].Patch, "+ONE") || diff.Changes[1].Additions != 1 || diff.Changes[1].Deletions != 1 {
		t.Fatalf("edit change: %+v", diff.Changes[1])
	}
	for _, change := range diff.Changes {
		if strings.Contains(change.Patch, "ignored") {
			t.Fatal("failed edit entered the diff")
		}
	}
	legacy, err := s.DiffArtifact(conversation.ID, paths["legacy.txt"])
	if err != nil || len(legacy.Changes) != 0 {
		t.Fatalf("legacy diff: %+v %v", legacy, err)
	}
	if _, err := s.DiffArtifact(conversation.ID, filepath.Join(workspace.Path, "unrecorded.txt")); err == nil {
		t.Fatal("diff accepted an unrecorded file")
	}
	s.mu.Lock()
	s.active.Running = true
	s.mu.Unlock()
	if _, err := s.DiffArtifact(conversation.ID, paths["sum.txt"]); err == nil {
		t.Fatal("diff inspection during run accepted")
	}
	s.mu.Lock()
	s.active.Running = false
	s.mu.Unlock()
}
