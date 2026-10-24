package workspacefs

import (
	"os"
	"path/filepath"
	"testing"
)

func TestServerDirectoryChecksReadAndTraversalWithoutRequiringWrite(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root bypasses directory permission checks")
	}
	folder := t.TempDir()
	defer os.Chmod(folder, 0700)
	for _, mode := range []os.FileMode{0000, 0100, 0400, 0500, 0700} {
		if err := os.Chmod(folder, mode); err != nil {
			t.Fatal(err)
		}
		_, err := ReadableDirectory(folder)
		want := mode == 0500 || mode == 0700
		if (err == nil) != want {
			t.Fatalf("permissions %o: %v", mode, err)
		}
	}
}

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

func TestWithinChecksCaseVariantsByFilesystemIdentity(t *testing.T) {
	base, err := Directory(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	parent, variant := filepath.Join(base, "Project"), filepath.Join(base, "project")
	for _, path := range []string{parent, variant} {
		if err := os.MkdirAll(filepath.Join(path, "nested"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	parentInfo, err := os.Stat(parent)
	if err != nil {
		t.Fatal(err)
	}
	variantInfo, err := os.Stat(variant)
	if err != nil {
		t.Fatal(err)
	}
	same := os.SameFile(parentInfo, variantInfo)
	for _, child := range []string{variant, filepath.Join(variant, "nested"), filepath.Join(variant, "missing", "new.txt")} {
		if got := Within(parent, child); got != same {
			t.Errorf("Within(%q, %q) = %v; same directory identity = %v", parent, child, got, same)
		}
	}
	if !Within(parent, filepath.Join(parent, "missing", "new.txt")) {
		t.Fatal("a new file inside the workspace was rejected")
	}
	if Within(parent, parent+"-sibling/new.txt") || Within(filepath.Join(parent, "nested"), variant) {
		t.Fatal("an unrelated or parent directory was treated as a descendant")
	}
	_, err = Relative(variant, parent, filepath.Join(variant, "missing", "new.txt"))
	if (err != nil) != same {
		t.Fatalf("private boundary for case variant: same=%v, error=%v", same, err)
	}
}
