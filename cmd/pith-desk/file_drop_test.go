package main

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/egoist/mygo"
)

func writeDroppedPNG(t *testing.T, path string) []byte {
	t.Helper()
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, encoded.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	return encoded.Bytes()
}

func TestNativeDropPayloadCarriesImageBytes(t *testing.T) {
	dir := t.TempDir()
	imagePath := filepath.Join(dir, "screen shot.png")
	imageBytes := writeDroppedPNG(t, imagePath)
	notes := filepath.Join(dir, "notes.md")
	if err := os.WriteFile(notes, []byte("# notes"), 0o644); err != nil {
		t.Fatal(err)
	}
	fake := filepath.Join(dir, "fake.webp")
	if err := os.WriteFile(fake, []byte("not an image"), 0o644); err != nil {
		t.Fatal(err)
	}
	large := filepath.Join(dir, "large.png")
	file, err := os.Create(large)
	if err != nil {
		t.Fatal(err)
	}
	if err = file.Truncate(droppedImageLimit + 1); err != nil {
		t.Fatal(err)
	}
	if err = file.Close(); err != nil {
		t.Fatal(err)
	}
	paths := []string{imagePath, notes, fake, large}

	payload := nativeDropPayloadFor(&mygo.FileDropEvent{Paths: paths, X: 12, Y: 34})
	// Reference resolution still sees every dropped path; the page filters images.
	if len(payload.Paths) != len(paths) || payload.Paths[0] != imagePath || payload.X != 12 || payload.Y != 34 {
		t.Fatalf("payload = %+v", payload)
	}
	if len(payload.Images) != 1 {
		t.Fatalf("images = %+v, want only the dropped PNG", payload.Images)
	}
	if got := payload.Images[0]; got.Name != "screen shot.png" || got.MimeType != "image/png" {
		t.Errorf("image = %+v", got)
	}
	if data, err := base64.StdEncoding.DecodeString(payload.Images[0].Data); err != nil || !bytes.Equal(data, imageBytes) {
		t.Errorf("image bytes changed: %v %v", len(data), err)
	}
	for _, name := range []string{"fake.webp", "large.png"} {
		if !strings.Contains(payload.Notice, name) {
			t.Errorf("notice %q does not report %s", payload.Notice, name)
		}
	}
	if strings.Contains(payload.Notice, "notes.md") {
		t.Errorf("notice %q reports a reference file as an image", payload.Notice)
	}

	script, err := nativeFileDropScript(&mygo.FileDropEvent{Paths: []string{imagePath}, X: 1, Y: 2})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"pith:file-drop", `"mimeType":"image/png"`, `"notice":""`} {
		if !strings.Contains(script, want) {
			t.Errorf("script %q does not contain %q", script, want)
		}
	}
}
