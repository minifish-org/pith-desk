package main

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

type brokenDownload struct{}

func (brokenDownload) Read([]byte) (int, error) { return 0, errors.New("Download interrupted") }

func TestDownloadedFileSavePreservesExistingDataOnFailureAndSupportsSavingOverSource(t *testing.T) {
	folder := t.TempDir()
	path := filepath.Join(folder, "saved.docx")
	content := []byte{'P', 'K', 3, 4, 0, 255}
	if err := saveDownloadedFile(path, bytes.NewReader(content)); err != nil {
		t.Fatal(err)
	}
	if err := saveDownloadedFile(path, io.MultiReader(bytes.NewReader([]byte("partial")), brokenDownload{})); err == nil {
		t.Fatal("broken download reported success")
	}
	data, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(data, content) {
		t.Fatalf("failed download changed destination: %q %v", data, err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err := saveDownloadedFile(path, file); err != nil {
		t.Fatal(err)
	}
	data, err = os.ReadFile(path)
	if err != nil || !bytes.Equal(data, content) {
		t.Fatalf("source was truncated: %q %v", data, err)
	}
	entries, err := os.ReadDir(folder)
	if err != nil || len(entries) != 1 {
		t.Fatalf("temporary downloads left behind: %v %v", entries, err)
	}
}
