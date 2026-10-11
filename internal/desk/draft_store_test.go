package desk

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDraftPruneRejectsExternalDirectorySymlink(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	outside := t.TempDir()
	path := filepath.Join(outside, "user.json")
	if err := os.WriteFile(path, []byte("user-owned"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(s.dataDir, "drafts")); err != nil {
		t.Fatal(err)
	}
	if err := s.cleanupDraftsLocked(); err == nil {
		t.Fatal("external draft directory accepted for cleanup")
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "user-owned" {
		t.Fatalf("user data touched: %q, %v", data, err)
	}
}
