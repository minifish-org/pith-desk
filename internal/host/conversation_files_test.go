package host

import (
	"errors"
	"io"
	"mime"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestConversationFileDownloadsRequireAuthenticationAndPreserveBinaryFilename(t *testing.T) {
	s := testServer(t)
	w, err := s.service.AddWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	c, err := s.service.CreateConversation(w.ID)
	if err != nil {
		t.Fatal(err)
	}
	name := "报告 v1.docx"
	content := string([]byte{'P', 'K', 3, 4, 0, 255})
	if err := os.WriteFile(filepath.Join(w.Path, name), []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	input := map[string]string{"id": c.ID, "path": name}
	path := "/api/conversation-file?id=" + url.QueryEscape(c.ID) + "&path=" + url.QueryEscape(name)
	for _, method := range []string{"GET", "POST"} {
		target := path
		if method == "POST" {
			target = "/api/conversation-file"
		}
		if status, _, _ := featureRequest(t, s, method, target, nil, false); status != 401 {
			t.Fatalf("unauthenticated download: %d", status)
		}
	}
	status, body, header := featureRequest(t, s, "GET", path, nil, true)
	kind, parameters, err := mime.ParseMediaType(header.Get("Content-Disposition"))
	if status != 200 || body != content || err != nil || kind != "attachment" || parameters["filename"] != name || header.Get("Cache-Control") != "no-store" {
		t.Fatalf("binary attachment: %d %q %v %v", status, body, header, err)
	}
	if status, body, _ := featureRequest(t, s, "POST", "/api/conversation-file", input, true); status != 200 || !strings.Contains(body, `"native":false`) {
		t.Fatalf("browser fallback: %d %s", status, body)
	}
	called := 0
	s.SetFileDownloadAction(func(filename string, source io.Reader) error {
		called++
		data, err := io.ReadAll(source)
		if err != nil || string(data) != content || filename != name {
			t.Fatalf("native copy: %q %q %v", filename, data, err)
		}
		return nil
	})
	if status, body, _ := featureRequest(t, s, "POST", "/api/conversation-file", input, true); status != 200 || called != 1 || !strings.Contains(body, `"native":true`) {
		t.Fatalf("native save: %d %s", status, body)
	}
	// A cancelled native dialog does not expose a browser fallback.
	s.SetFileDownloadAction(func(string, io.Reader) error { return nil })
	if status, body, _ := featureRequest(t, s, "POST", "/api/conversation-file", input, true); status != 200 || !strings.Contains(body, `"native":true`) {
		t.Fatalf("cancelled save fell back: %d %s", status, body)
	}
	s.SetFileDownloadAction(func(string, io.Reader) error { return errors.New("Save failed") })
	if status, body, _ := featureRequest(t, s, "POST", "/api/conversation-file", input, true); status != 400 || !strings.Contains(body, "Save failed") {
		t.Fatalf("save error: %d %s", status, body)
	}
	for _, invalid := range []string{"", filepath.Join(t.TempDir(), "secret.docx"), w.Path, "missing.docx"} {
		input["path"] = invalid
		if status, _, _ := featureRequest(t, s, "POST", "/api/conversation-file", input, true); status != 400 {
			t.Fatalf("invalid local path accepted: %q %d", invalid, status)
		}
	}
}
