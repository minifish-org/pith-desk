package desk

import (
	"io"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestWorkspaceBrowserIsLazyAndKeepsFileBoundaries(t *testing.T) {
	s, workspace, conversation, private := productFeatureService(t)
	for name, text := range map[string]string{"README.md": "# Workspace", "docs/中文 draft.txt": "nested content"} {
		path := filepath.Join(workspace.Path, name)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
	}
	outside := t.TempDir()
	for name, target := range map[string]string{"outside": outside, "private": private, "cycle": workspace.Path, "alias": filepath.Join(workspace.Path, "docs")} {
		if err := os.Symlink(target, filepath.Join(workspace.Path, name)); err != nil {
			t.Fatal(err)
		}
	}
	listing, err := s.WorkspaceFiles(workspace.ID, "", "")
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, entry := range listing.Entries {
		names = append(names, entry.Path)
	}
	if !reflect.DeepEqual(names, []string{"alias", "cycle", "docs", "README.md"}) {
		t.Fatalf("root must list only immediate safe entries: %v", names)
	}
	listing, err = s.WorkspaceFiles(workspace.ID, "docs", "")
	if err != nil || len(listing.Entries) != 1 || listing.Entries[0].Path != "docs/中文 draft.txt" {
		t.Fatalf("nested listing: %+v %v", listing, err)
	}
	search, err := s.WorkspaceFiles(workspace.ID, "", "DRAFT")
	if err != nil || len(search.Entries) != 1 || search.Entries[0].Path != "docs/中文 draft.txt" {
		t.Fatalf("bounded name search including cycle: %+v %v", search, err)
	}
	preview, err := s.PreviewWorkspaceFile(workspace.ID, "README.md")
	if err != nil || preview.Kind != "markdown" || preview.Text != "# Workspace" {
		t.Fatalf("preview: %+v %v", preview, err)
	}
	name, file, err := s.OpenWorkspaceFile(workspace.ID, "docs/中文 draft.txt")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err := os.Remove(filepath.Join(workspace.Path, "docs/中文 draft.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(private, "settings.json"), filepath.Join(workspace.Path, "docs/中文 draft.txt")); err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(file)
	if err != nil || name != "中文 draft.txt" || string(data) != "nested content" {
		t.Fatalf("opened handle redirected: %q %v", data, err)
	}
	for _, forbidden := range []string{"../", outside, "outside", "private", "docs/中文 draft.txt", "missing"} {
		if _, err := s.WorkspaceFiles(workspace.ID, forbidden, ""); err == nil {
			t.Fatalf("unsafe directory %q accepted", forbidden)
		}
		if _, err := s.PreviewWorkspaceFile(workspace.ID, forbidden); err == nil {
			t.Fatalf("unsafe preview %q accepted", forbidden)
		}
		if _, source, err := s.OpenWorkspaceFile(workspace.ID, forbidden); err == nil {
			source.Close()
			t.Fatalf("unsafe download %q accepted", forbidden)
		}
	}
	if _, err := s.WorkspaceFiles("missing", "", ""); err == nil {
		t.Fatal("unknown workspace accepted")
	}
	if artifacts, err := s.Artifacts(conversation.ID); err != nil || len(artifacts) != 0 {
		t.Fatalf("workspace entries changed generated file count: %+v %v", artifacts, err)
	}
}

func TestWorkspaceBrowserSearchIsBoundedAndDirectoryRefreshReadsAgain(t *testing.T) {
	s, workspace, _, _ := productFeatureService(t)
	for i := range maxWorkspaceMatches + 1 {
		if err := os.WriteFile(filepath.Join(workspace.Path, "match-"+string(rune(0x4e00+i))), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	result, err := s.WorkspaceFiles(workspace.ID, "", "match-")
	if err != nil || !result.Truncated || len(result.Entries) != maxWorkspaceMatches {
		t.Fatalf("unbounded search: %d %v %v", len(result.Entries), result.Truncated, err)
	}
	if err := os.WriteFile(filepath.Join(workspace.Path, "new.txt"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	result, err = s.WorkspaceFiles(workspace.ID, "", "new.txt")
	if err != nil || len(result.Entries) != 1 {
		t.Fatalf("refresh retained stale entries: %+v %v", result, err)
	}
}
