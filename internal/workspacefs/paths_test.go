package workspacefs

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRelativeGuardsSymlinksPrivateDataAndMissingPaths(t *testing.T) {
	workspace, err := Directory(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	private, err := Directory(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range []struct{ name, target string }{{"internal", workspace}, {"external", private}, {"dangling", filepath.Join(private, "absent")}} {
		if err := os.Symlink(entry.target, filepath.Join(workspace, entry.name)); err != nil {
			t.Fatal(err)
		}
	}
	for _, entry := range []struct {
		path     string
		allowed  bool
		relative string
	}{
		{filepath.Join(workspace, "new", "file.txt"), true, filepath.Join("new", "file.txt")},
		{filepath.Join(workspace, "internal", "new", "file.txt"), true, filepath.Join("new", "file.txt")},
		{filepath.Join(workspace, "external", "new.txt"), false, ""},
		{filepath.Join(workspace, "dangling", "new.txt"), false, ""},
		{workspace + "-sibling/file.txt", false, ""},
	} {
		t.Run(entry.path, func(t *testing.T) {
			rel, err := Relative(workspace, private, entry.path)
			if entry.allowed && (err != nil || rel != entry.relative) {
				t.Fatalf("allowed path: %q, %v", rel, err)
			}
			if !entry.allowed && err == nil {
				t.Fatalf("escape allowed: %q", rel)
			}
		})
	}
	if _, err := Relative(workspace, filepath.Join(workspace, "new"), filepath.Join(workspace, "new", "file.txt")); err == nil {
		t.Fatal("private descendant allowed")
	}
}
