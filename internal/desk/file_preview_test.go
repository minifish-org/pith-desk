package desk

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestArtifactPreviewsRequireRecordedFilesAndKeepActiveContentAsText(t *testing.T) {
	s, workspace, conversation, _ := productFeatureService(t)
	var imageData bytes.Buffer
	if err := png.Encode(&imageData, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	files := map[string][]byte{
		"note.md": []byte("# Hello\n\n**中文**"), "animation.html": []byte("<script>window.hacked=true</script>"),
		"picture.png": imageData.Bytes(), "long.txt": []byte(strings.Repeat("中", maxTextPreviewBytes)),
		"binary.bin": {0, 1, 2, 3}, "unrecorded.txt": []byte("not a result"),
	}
	manager, err := openDeskSession(s.sessionFile(conversation.ID), conversation.ID, workspace.Path)
	if err != nil {
		t.Fatal(err)
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(workspace.Path, name), content, 0644); err != nil {
			t.Fatal(err)
		}
		if name != "unrecorded.txt" {
			recordFeatureArtifact(t, manager, name, "write_file", name, false)
		}
	}
	manager.Close()
	for _, tc := range []struct {
		name, kind string
		truncated  bool
	}{{"note.md", "markdown", false}, {"animation.html", "text", false}, {"picture.png", "image", false}, {"long.txt", "text", true}} {
		preview, err := s.PreviewArtifact(conversation.ID, filepath.Join(workspace.Path, tc.name))
		if err != nil || preview.Kind != tc.kind || preview.Truncated != tc.truncated {
			t.Fatalf("%s: %+v %v", tc.name, preview, err)
		}
		if tc.kind == "image" {
			data, _ := base64.StdEncoding.DecodeString(preview.Data)
			if !bytes.Equal(data, imageData.Bytes()) {
				t.Fatal("image changed")
			}
		}
	}
	for _, name := range []string{"unrecorded.txt", "binary.bin", "../outside.txt"} {
		if _, err := s.PreviewArtifact(conversation.ID, filepath.Join(workspace.Path, name)); err == nil {
			t.Fatalf("unpreviewable file accepted: %s", name)
		}
	}
	outside := filepath.Join(t.TempDir(), "outside.txt")
	if err := os.WriteFile(outside, []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(workspace.Path, "note.md")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, path); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PreviewArtifact(conversation.ID, path); err == nil {
		t.Fatal("swapped symlink escaped preview boundary")
	}
}
