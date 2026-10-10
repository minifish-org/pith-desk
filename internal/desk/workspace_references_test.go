package desk

import (
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestWorkspaceFileReferencesPreserveIdentityAndRelativePaths(t *testing.T) {
	s, workspace, _, _ := productFeatureService(t)
	name := filepath.Join("docs", "中文 draft.md")
	path := filepath.Join(workspace.Path, name)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("kept in workspace"), 0644); err != nil {
		t.Fatal(err)
	}
	second := filepath.Join(workspace.Path, "README.md")
	if err := os.WriteFile(second, []byte("second file"), 0644); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(workspace.Path, "alias.md")
	if err := os.Symlink(path, alias); err != nil {
		t.Fatal(err)
	}
	uri := (&url.URL{Scheme: "file", Path: filepath.ToSlash(path)}).String()
	refs, err := s.WorkspaceFileReferences(workspace.ID, []string{path, uri, alias, second})
	if err != nil || !reflect.DeepEqual(refs, []string{"docs/中文 draft.md", "README.md"}) {
		t.Fatalf("references=%v err=%v", refs, err)
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != "kept in workspace" {
		t.Fatalf("referencing changed file contents: %q %v", data, err)
	}
}

func TestWorkspaceFileReferencesRejectUnverifiedAndEscapingPaths(t *testing.T) {
	s, workspace, _, dataDir := productFeatureService(t)
	inside := filepath.Join(workspace.Path, "valid.txt")
	outside := filepath.Join(filepath.Dir(workspace.Path), "outside.txt")
	private := filepath.Join(dataDir, "private.txt")
	for _, path := range []string{inside, outside, private} {
		if err := os.WriteFile(path, []byte("content"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	for name, target := range map[string]string{"outside-link": outside, "private-link": private, "dangling": filepath.Join(workspace.Path, "absent")} {
		if err := os.Symlink(target, filepath.Join(workspace.Path, name)); err != nil {
			t.Fatal(err)
		}
	}
	for _, path := range []string{
		"valid.txt", // A same-named browser File is not proof of identity.
		outside, private, workspace.Path, filepath.Join(workspace.Path, "missing"),
		filepath.Join(workspace.Path, "outside-link"), filepath.Join(workspace.Path, "private-link"), filepath.Join(workspace.Path, "dangling"),
		"file://remote.example" + inside, "file:" + inside + "?query=yes", "file:" + inside + "#fragment", "file:" + inside + "%00", "https://example.com/valid.txt",
	} {
		t.Run(path, func(t *testing.T) {
			refs, err := s.WorkspaceFileReferences(workspace.ID, []string{inside, path})
			if err == nil || refs != nil {
				t.Fatalf("unsafe batch accepted: %v %v", refs, err)
			}
		})
	}
	for _, paths := range [][]string{nil, make([]string, 101)} {
		if _, err := s.WorkspaceFileReferences(workspace.ID, paths); err == nil {
			t.Fatal("unbounded or empty drop accepted")
		}
	}
	if _, err := s.WorkspaceFileReferences("unknown", []string{inside}); err == nil {
		t.Fatal("unknown workspace accepted")
	}
}
