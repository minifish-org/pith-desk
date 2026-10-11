package desk

import (
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestConversationDownloadsAllowUnrecordedFilesButKeepTheirWorkspaceAndOpenHandle(t *testing.T) {
	s, workspace, conversation, dataDir := productFeatureService(t)
	name := "报告 v1.docx"
	path := filepath.Join(workspace.Path, name)
	content := []byte{'P', 'K', 3, 4, 0, 255}
	if err := os.WriteFile(path, content, 0600); err != nil {
		t.Fatal(err)
	}
	other, err := s.AddWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateConversation(other.ID); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(other.Path, name), []byte("Other workspace"), 0600); err != nil {
		t.Fatal(err)
	}
	filename, file, err := s.OpenConversationFile(conversation.ID, name)
	if err != nil || filename != name {
		t.Fatalf("inactive conversation download: %q %v", filename, err)
	}
	defer file.Close()
	outside := filepath.Join(t.TempDir(), "private.docx")
	if err := os.WriteFile(outside, []byte("Outside workspace"), 0600); err != nil {
		t.Fatal(err)
	}
	private := filepath.Join(dataDir, "private.docx")
	if err := os.WriteFile(private, []byte("Private application data"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(private, filepath.Join(workspace.Path, "private-link.docx")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, path); err != nil {
		t.Fatal(err)
	}
	bytes, err := io.ReadAll(file)
	if err != nil || string(bytes) != string(content) {
		t.Fatalf("opened source redirected after path replacement: %q %v", bytes, err)
	}
	for _, forbidden := range []string{"", name, outside, dataDir, "private-link.docx", "missing.docx", workspace.Path} {
		if _, source, err := s.OpenConversationFile(conversation.ID, forbidden); err == nil {
			source.Close()
			t.Fatalf("invalid file accepted: %q", forbidden)
		}
	}
	if artifacts, err := s.Artifacts(conversation.ID); err != nil || len(artifacts) != 0 {
		t.Fatalf("unrecorded files entered artifact list: %+v %v", artifacts, err)
	}
}
