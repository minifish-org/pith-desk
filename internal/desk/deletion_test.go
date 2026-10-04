package desk

import (
	"image/color"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	aitypes "github.com/minifish-org/pith/packages/ai/types"
)

func seedDeletionData(t *testing.T, s *Service, workspace Workspace, conversation Conversation) string {
	t.Helper()
	manager, err := openDeskSession(s.sessionFile(conversation.ID), conversation.ID, workspace.Path)
	if err != nil {
		t.Fatal(err)
	}
	image := imageFixture(t, color.RGBA{R: 255, A: 255})
	message := aitypes.NewUserMessageBlocks([]aitypes.ContentBlock{aitypes.TextBlock("An attached image"), aitypes.ImageBlock(image.Data, image.MimeType)}, 1)
	appendFeatureMessage(t, manager, aitypes.NewUserMessageVariant(message))
	entries := manager.Context()
	messageID := entries[len(entries)-1].ID
	if err := manager.Close(); err != nil {
		t.Fatal(err)
	}
	if err := writeJSON(s.receiptFile(conversation.ID), runReceipt{Runtime: RuntimeStatus{Phase: "complete", Model: "fixture"}}); err != nil {
		t.Fatal(err)
	}
	return messageID
}

func requireNoConversationData(t *testing.T, s *Service, ids ...string) {
	t.Helper()
	for _, id := range ids {
		for _, file := range []string{s.sessionFile(id), s.receiptFile(id)} {
			if _, err := os.Lstat(file); !os.IsNotExist(err) {
				t.Fatalf("deleted data still exists: %s (%v)", file, err)
			}
		}
		if err := s.OpenConversation(id); err == nil {
			t.Fatal("deleted conversation can still be opened")
		}
	}
}

func TestDeleteConversationRemovesAttachmentsAndReceiptsWithoutTouchingWorkspace(t *testing.T) {
	s, workspace, conversation, dataDir := productFeatureService(t)
	messageID := seedDeletionData(t, s, workspace, conversation)
	if _, _, err := s.ConversationImage(conversation.ID, messageID, 0); err != nil {
		t.Fatal(err)
	}
	userFile := filepath.Join(workspace.Path, "created-by-agent.md")
	if err := os.WriteFile(userFile, []byte("keep me"), 0600); err != nil {
		t.Fatal(err)
	}
	other, err := s.CreateConversation(workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	seedDeletionData(t, s, workspace, other)
	if err := s.DeleteConversation(conversation.ID); err != nil {
		t.Fatal(err)
	}
	requireNoConversationData(t, s, conversation.ID)
	if _, _, err := s.ConversationImage(conversation.ID, messageID, 0); err == nil {
		t.Fatal("deleted image can still be read")
	}
	if s.Snapshot().ActiveID != other.ID || len(s.Snapshot().Conversations) != 1 {
		t.Fatal("deleting an inactive conversation changed active history")
	}
	if err := s.OpenConversation(other.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteConversation(other.ID); err != nil {
		t.Fatal(err)
	}
	requireNoConversationData(t, s, other.ID)
	state := s.Snapshot()
	if state.ActiveID != "" || len(state.Messages) != 0 || state.Runtime.Model != "" || state.Failure != nil || len(state.QueuedMessages) != 0 || len(state.Conversations) != 0 || len(state.Workspaces) != 1 {
		t.Fatal("deleting the active conversation left stale state")
	}
	if data, err := os.ReadFile(userFile); err != nil || string(data) != "keep me" {
		t.Fatal("deletion changed a workspace file")
	}
	s.Close()
	reopened, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if len(reopened.Snapshot().Conversations) != 0 || reopened.Snapshot().ActiveID != "" {
		t.Fatal("deleted conversations returned after restart")
	}
}

func TestRemoveWorkspaceDeletesAllItsConversationsAndPreservesOtherWorkspace(t *testing.T) {
	s, workspace, first, dataDir := productFeatureService(t)
	workspaceFile := filepath.Join(workspace.Path, "keep.txt")
	if err := os.WriteFile(workspaceFile, []byte("keep workspace files"), 0600); err != nil {
		t.Fatal(err)
	}
	seedDeletionData(t, s, workspace, first)
	second, err := s.CreateConversation(workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	seedDeletionData(t, s, workspace, second)
	otherWorkspace, err := s.AddWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	other, err := s.CreateConversation(otherWorkspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	seedDeletionData(t, s, otherWorkspace, other)
	before := s.Snapshot()
	if err := s.RemoveWorkspace(workspace.ID, 1); err == nil {
		t.Fatal("stale removal confirmation accepted")
	}
	if !reflect.DeepEqual(before, s.Snapshot()) {
		t.Fatal("failed removal changed state")
	}
	if err := s.RemoveWorkspace(workspace.ID, 2); err != nil {
		t.Fatal(err)
	}
	requireNoConversationData(t, s, first.ID, second.ID)
	state := s.Snapshot()
	if len(state.Workspaces) != 1 || state.Workspaces[0].ID != otherWorkspace.ID || len(state.Conversations) != 1 || state.ActiveID != other.ID {
		t.Fatal("workspace removal affected unrelated data")
	}
	if _, err := os.Stat(workspace.Path); err != nil {
		t.Fatal("workspace folder removed")
	}
	if data, err := os.ReadFile(workspaceFile); err != nil || string(data) != "keep workspace files" {
		t.Fatal("workspace removal deleted user file")
	}
	if err := s.RemoveWorkspace(otherWorkspace.ID, 1); err != nil {
		t.Fatal(err)
	}
	requireNoConversationData(t, s, other.ID)
	s.Close()
	reopened, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if st := reopened.Snapshot(); len(st.Workspaces) != 0 || len(st.Conversations) != 0 || st.ActiveID != "" {
		t.Fatal("workspace or dangling chats returned after restart")
	}
	// Unlinking an empty workspace is also supported without creating a chat.
	empty, err := reopened.AddWorkspace(workspace.Path)
	if err != nil {
		t.Fatal(err)
	}
	if err := reopened.RemoveWorkspace(empty.ID, 0); err != nil {
		t.Fatal(err)
	}
}

func TestDeletionFailurePreservesCatalogAndData(t *testing.T) {
	s, workspace, conversation, dataDir := productFeatureService(t)
	seedDeletionData(t, s, workspace, conversation)
	before := s.Snapshot()
	file := s.sessionFile(conversation.ID)
	bytes, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	catalog := filepath.Join(dataDir, "catalog.json")
	if err := os.Remove(catalog); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(catalog, 0700); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteConversation(conversation.ID); err == nil {
		t.Fatal("catalog failure hidden")
	}
	if !reflect.DeepEqual(before, s.Snapshot()) {
		t.Fatal("failed delete changed state")
	}
	if data, err := os.ReadFile(file); err != nil || string(data) != string(bytes) {
		t.Fatal("failed delete removed transcript")
	}
	if err := os.Remove(catalog); err != nil {
		t.Fatal(err)
	}
	if err := s.persistCatalogLocked(); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteConversation("../../outside"); err == nil {
		t.Fatal("unknown ID accepted")
	}
	if err := s.RemoveWorkspace("missing", 0); err == nil {
		t.Fatal("unknown workspace accepted")
	}
}

func TestDeletionRecoveryUsesCommittedCatalog(t *testing.T) {
	s, workspace, kept, dataDir := productFeatureService(t)
	seedDeletionData(t, s, workspace, kept)
	removed, err := s.CreateConversation(workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	seedDeletionData(t, s, workspace, removed)
	// Simulate exit after persisting delete intent and a catalog without removed.
	if err := writeJSON(filepath.Join(dataDir, deletionFile), []string{kept.ID, removed.ID}); err != nil {
		t.Fatal(err)
	}
	if err := writeJSON(filepath.Join(dataDir, "catalog.json"), catalogState{Workspaces: []Workspace{workspace}, Conversations: []Conversation{kept}, ActiveID: kept.ID}); err != nil {
		t.Fatal(err)
	}
	s.Close()
	reopened, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	requireNoConversationData(t, reopened, removed.ID)
	if _, err := os.Stat(reopened.sessionFile(kept.ID)); err != nil {
		t.Fatal("uncommitted deletion removed kept conversation")
	}
	if _, err := os.Stat(filepath.Join(dataDir, deletionFile)); !os.IsNotExist(err) {
		t.Fatal("completed deletion intent retained")
	}
}

func TestInterruptedDeletionRetainsIntentUntilCleanupCanFinish(t *testing.T) {
	s, workspace, conversation, dataDir := productFeatureService(t)
	seedDeletionData(t, s, workspace, conversation)
	if err := writeJSON(filepath.Join(dataDir, deletionFile), []string{conversation.ID}); err != nil {
		t.Fatal(err)
	}
	if err := writeJSON(filepath.Join(dataDir, "catalog.json"), catalogState{Workspaces: []Workspace{workspace}, Conversations: []Conversation{}}); err != nil {
		t.Fatal(err)
	}
	// An unexpected directory blocks cleanup; it must not be recursively removed.
	if err := os.Remove(s.receiptFile(conversation.ID)); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(s.receiptFile(conversation.ID), 0700); err != nil {
		t.Fatal(err)
	}
	s.Close()
	if recovered, err := New(dataDir); err == nil {
		recovered.Close()
		t.Fatal("cleanup failure was hidden")
	}
	if _, err := os.Stat(filepath.Join(dataDir, deletionFile)); err != nil {
		t.Fatal("failed cleanup lost retry intent")
	}
	if _, err := os.Stat(s.sessionFile(conversation.ID)); err != nil {
		t.Fatal("preflight did not preserve data on failure")
	}
	if err := os.Remove(s.receiptFile(conversation.ID)); err != nil {
		t.Fatal(err)
	}
	recovered, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer recovered.Close()
	requireNoConversationData(t, recovered, conversation.ID)
	if _, err := os.Stat(filepath.Join(dataDir, deletionFile)); !os.IsNotExist(err) {
		t.Fatal("retry did not finish deletion")
	}
}

func TestDeletionDoesNotFollowWorkspaceSymlinksOrDeleteUnexpectedDirectories(t *testing.T) {
	s, workspace, conversation, dataDir := productFeatureService(t)
	outside := filepath.Join(workspace.Path, conversation.ID+".jsonl")
	if err := os.WriteFile(outside, []byte("user file"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(workspace.Path, filepath.Join(dataDir, "sessions")); err != nil {
		t.Fatal(err)
	}
	before := s.Snapshot()
	if err := s.DeleteConversation(conversation.ID); err == nil {
		t.Fatal("deletion followed parent symlink out of private data")
	}
	if data, err := os.ReadFile(outside); err != nil || string(data) != "user file" {
		t.Fatal("deleted user's file through symlink")
	}
	if !reflect.DeepEqual(before, s.Snapshot()) {
		t.Fatal("unsafe delete changed catalog")
	}
	if err := os.Remove(filepath.Join(dataDir, "sessions")); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(s.sessionFile(conversation.ID), 0700); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteConversation(conversation.ID); err == nil {
		t.Fatal("unexpected directory was deleted recursively")
	}
}
