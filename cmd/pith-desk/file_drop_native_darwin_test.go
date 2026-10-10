package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo"
	"github.com/minifish-org/pith-desk/internal/desk"
	"github.com/minifish-org/pith-desk/internal/host"
)

// This sends a synthetic native event through the production forwarding code,
// then checks the real embedded UI and authenticated HTTP host in a WebView.
// It does not simulate the operating system's Finder drag gesture.
func TestWorkspaceFileDropNativeBridge(t *testing.T) {
	if os.Getenv("PITH_DESK_NATIVE_SMOKE") != "1" {
		t.Skip("set PITH_DESK_NATIVE_SMOKE=1 for native macOS file-drop bridge verification")
	}
	base := t.TempDir()
	service, err := desk.New(filepath.Join(base, "private"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(service.Close)
	workspacePath := filepath.Join(base, "workspace")
	if err := os.MkdirAll(filepath.Join(workspacePath, "docs"), 0755); err != nil {
		t.Fatal(err)
	}
	workspace, err := service.AddWorkspace(workspacePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.CreateConversation(workspace.ID); err != nil {
		t.Fatal(err)
	}
	paths := []string{filepath.Join(workspace.Path, "docs", "需求 draft.md"), filepath.Join(workspace.Path, "中文 file.txt")}
	outside := filepath.Join(filepath.Dir(workspace.Path), "outside.txt")
	hashes := map[string][32]byte{}
	for _, path := range append(append([]string(nil), paths...), outside) {
		data := []byte("Keep this original file: " + filepath.Base(path))
		if err := os.WriteFile(path, data, 0644); err != nil {
			t.Fatal(err)
		}
		hashes[path] = sha256.Sum256(data)
	}
	server, err := host.Start(service, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	var win *mygo.Window
	mygo.RunOnMain(func() {
		win = mygo.NewWindow(mygo.WindowOptions{Title: "Pith Desk file drop smoke", Hidden: true, Width: 1320, Height: 860})
		installWorkspaceFileDrop(win, server)
	})
	t.Cleanup(win.Destroy)
	loaded := make(chan struct{}, 1)
	failed := make(chan string, 1)
	win.Page().OnDidFinishLoad(func() {
		select {
		case loaded <- struct{}{}:
		default:
		}
	})
	win.Page().OnDidFailLoad(func(err *mygo.LoadError) {
		select {
		case failed <- err.Error():
		default:
		}
	})
	if err := win.Page().LoadURL(server.URL); err != nil {
		t.Fatal(err)
	}
	select {
	case <-loaded:
	case err := <-failed:
		t.Fatalf("embedded UI load: %s", err)
	case <-time.After(10 * time.Second):
		t.Fatal("embedded UI did not load")
	}
	waitNativeDropCondition(t, win, `document.querySelector('#workspace-label')?.textContent === 'workspace' && document.querySelector('#composer-input')?.placeholder !== 'Connecting to Pith…'`)
	var point struct {
		X int `json:"x"`
		Y int `json:"y"`
	}
	data, err := json.Marshal(nativeDropEval(t, win, `
const input = document.querySelector('#composer-input');
input.value = 'Review OLD please'; input.setSelectionRange(7, 10);
window.__dropReferenceRequests = 0;
const originalFetch = window.fetch;
window.fetch = (...args) => { if (String(args[0]) === '/api/workspace-references') window.__dropReferenceRequests++; return originalFetch.apply(window, args); };
const rect = input.getBoundingClientRect();
return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };`))
	if err != nil || json.Unmarshal(data, &point) != nil {
		t.Fatalf("composer coordinates: %s %v", data, err)
	}
	if err := forwardNativeFileDrop(win, &mygo.FileDropEvent{Paths: paths, X: point.X, Y: point.Y}); err != nil {
		t.Fatal(err)
	}
	want := "Review `docs/需求 draft.md` `中文 file.txt` please"
	encodedWant, _ := json.Marshal(want)
	waitNativeDropCondition(t, win, "document.querySelector('#composer-input').value === "+string(encodedWant))
	t.Logf("native bridge inserted %q through the embedded WebView and authenticated host", want)

	if err := forwardNativeFileDrop(win, &mygo.FileDropEvent{Paths: []string{outside}, X: point.X, Y: point.Y}); err != nil {
		t.Fatal(err)
	}
	waitNativeDropCondition(t, win, `document.querySelector('#inline-error').textContent.includes('selected workspace')`)
	if value := nativeDropEval(t, win, `document.querySelector('#composer-input').value`); value != want {
		t.Fatalf("outside path changed draft: %v", value)
	}
	if requests := nativeDropEval(t, win, `window.__dropReferenceRequests`); requests != float64(2) {
		t.Fatalf("unexpected validation request count: %v", requests)
	}
	if err := forwardNativeFileDrop(win, &mygo.FileDropEvent{Paths: paths, X: 10, Y: 10}); err != nil {
		t.Fatal(err)
	}
	if requests := nativeDropEval(t, win, `window.__dropReferenceRequests`); requests != float64(2) {
		t.Fatalf("drop outside composer reached validation: %v", requests)
	}
	if value := nativeDropEval(t, win, `document.querySelector('#composer-input').value`); value != want {
		t.Fatalf("drop outside composer changed draft: %v", value)
	}
	for path, expected := range hashes {
		data, err := os.ReadFile(path)
		if err != nil || sha256.Sum256(data) != expected {
			t.Fatalf("drop changed original file %s: %v", path, err)
		}
	}
	t.Log("outside file rejected; drop outside composer ignored; original file SHA-256 hashes unchanged")
}

func nativeDropEval(t *testing.T, win *mygo.Window, code string) any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	value, err := win.Page().EvalContext(ctx, code)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func waitNativeDropCondition(t *testing.T, win *mygo.Window, condition string) {
	t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		if nativeDropEval(t, win, condition) == true {
			return
		}
		time.Sleep(15 * time.Millisecond)
	}
	value := nativeDropEval(t, win, `({draft: document.querySelector('#composer-input')?.value, error: document.querySelector('#inline-error')?.textContent, workspace: document.querySelector('#workspace-label')?.textContent})`)
	t.Fatalf("native UI condition failed (%s): %v", strings.TrimSpace(condition), value)
}
