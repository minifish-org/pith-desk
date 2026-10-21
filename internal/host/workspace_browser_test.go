package host

import (
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWorkspaceBrowserServerLeaseAndDesktopActions(t *testing.T) {
	s := testServerMode(t, "")
	w, err := s.service.AddWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(w.Path, "报告.txt"), []byte("workspace content"), 0600); err != nil {
		t.Fatal(err)
	}
	b := &serverBrowser{s: s}
	b.login(t)
	b.acquire(t, "", false)
	query := "?workspaceId=" + url.QueryEscape(w.ID) + "&path=" + url.QueryEscape("报告.txt")
	for _, path := range []string{"/api/workspace-files?workspaceId=" + url.QueryEscape(w.ID) + "&path=", "/api/workspace-preview" + query, "/api/workspace-file" + query} {
		resp, data := b.request(t, "GET", path, nil, "")
		if resp.StatusCode != 200 || resp.Header.Get("Cache-Control") != "no-store" {
			t.Fatalf("workspace read: %d %s", resp.StatusCode, data)
		}
	}
	other := &serverBrowser{s: s}
	other.login(t)
	other.acquire(t, "", true)
	for _, path := range []string{"/api/workspace-files?workspaceId=" + url.QueryEscape(w.ID) + "&path=", "/api/workspace-preview" + query, "/api/workspace-file" + query} {
		resp, data := b.request(t, "GET", path, nil, "")
		if resp.StatusCode != 409 {
			t.Fatalf("revoked read: %d %s", resp.StatusCode, data)
		}
	}
	resp, data := b.request(t, "POST", "/api/workspace-file", map[string]string{"workspaceId": w.ID, "path": "报告.txt"}, "")
	if resp.StatusCode != 409 {
		t.Fatalf("revoked download action: %d %s", resp.StatusCode, data)
	}
	// Native actions retain the existing shell and save callbacks in Desktop.
	desktop := testServer(t)
	dw, err := desktop.service.AddWorkspace(w.Path)
	if err != nil {
		t.Fatal(err)
	}
	opened, revealed, copied, saved := 0, 0, 0, 0
	desktop.SetFileActions(func(path string) error { opened++; return nil }, func(path string) error { revealed++; return nil })
	desktop.SetClipboardActions(nil, func(path string) error { copied++; return nil })
	for _, action := range []string{"open", "reveal", "copy"} {
		status, body, _ := featureRequest(t, desktop, "POST", "/api/file", map[string]string{"kind": "workspace", "workspaceId": dw.ID, "path": "报告.txt", "action": action}, true)
		if status != 200 {
			t.Fatalf("native %s: %d %s", action, status, body)
		}
	}
	desktop.SetFileDownloadAction(func(name string, source io.Reader) error {
		saved++
		data, err := io.ReadAll(source)
		if name != "报告.txt" || string(data) != "workspace content" {
			t.Fatal("native save changed file")
		}
		return err
	})
	status, body, _ := featureRequest(t, desktop, "POST", "/api/workspace-file", map[string]string{"workspaceId": dw.ID, "path": "报告.txt"}, true)
	if status != 200 || !strings.Contains(body, `"native":true`) || opened != 1 || revealed != 1 || copied != 1 || saved != 1 {
		t.Fatalf("native callbacks: %d %s %d %d %d %d", status, body, opened, revealed, copied, saved)
	}
}
