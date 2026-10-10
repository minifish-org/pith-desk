package desk

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDraftsSurviveRestartAndRejectLateSavesAfterClear(t *testing.T) {
	s, workspace, conversation, dataDir := productFeatureService(t)
	first := DraftScope{ID: conversation.ID}
	secondConversation, err := s.CreateConversation(workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	second := DraftScope{ID: secondConversation.ID}
	workspaceScope := DraftScope{WorkspaceID: workspace.ID}
	for i, scope := range []DraftScope{first, second, workspaceScope} {
		text := []string{"第一份草稿\n `a b.md` ", "Another draft", "Before creating a conversation"}[i]
		if _, err := s.SaveDraft(DraftInput{DraftScope: scope, Draft: Draft{Text: text, Revision: 100}}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.SaveDraft(DraftInput{DraftScope: first, Draft: Draft{Revision: 102}}); err != nil {
		t.Fatal(err)
	}
	if got, err := s.SaveDraft(DraftInput{DraftScope: first, Draft: Draft{Text: "late old text", Revision: 101}}); err != nil || got.Text != "" {
		t.Fatalf("late save revived text: %+v %v", got, err)
	}
	s.Close()
	reopened, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	for _, tc := range []struct {
		scope DraftScope
		text  string
	}{{first, ""}, {second, "Another draft"}, {workspaceScope, "Before creating a conversation"}} {
		got, err := reopened.Draft(tc.scope)
		if err != nil || got.Text != tc.text {
			t.Fatalf("draft not restored: %+v %v", got, err)
		}
	}
	info, err := os.Stat(filepath.Join(dataDir, "drafts", second.ID+".json"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("draft isn't private: %v %v", info, err)
	}
	if err := reopened.DeleteConversation(second.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "drafts", second.ID+".json")); !os.IsNotExist(err) {
		t.Fatalf("deleted conversation retained draft: %v", err)
	}
	if err := reopened.RemoveWorkspace(workspace.ID, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "drafts", "workspace-"+workspace.ID+".json")); !os.IsNotExist(err) {
		t.Fatalf("removed workspace retained draft: %v", err)
	}
}

func TestDraftsValidateScopeAndSizeWithoutChangingExistingText(t *testing.T) {
	s, workspace, conversation, _ := productFeatureService(t)
	for _, in := range []DraftInput{
		{DraftScope: DraftScope{ID: "../outside"}, Draft: Draft{Revision: 1}},
		{DraftScope: DraftScope{ID: conversation.ID, WorkspaceID: workspace.ID}, Draft: Draft{Revision: 1}},
		{DraftScope: DraftScope{ID: conversation.ID}, Draft: Draft{Text: strings.Repeat("a", MaxDraftBytes+1), Revision: 1}},
		{DraftScope: DraftScope{ID: conversation.ID}, Draft: Draft{Revision: -1}},
	} {
		if _, err := s.SaveDraft(in); err == nil {
			t.Fatalf("invalid draft accepted: %+v", in.DraftScope)
		}
	}
	got, err := s.Draft(DraftScope{ID: conversation.ID})
	if err != nil || got.Text != "" || got.Revision != 0 {
		t.Fatalf("invalid save changed draft: %+v %v", got, err)
	}
}
