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
	server, err := startNativeSmokeHost(service)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	var win *desktopWindow
	mygo.RunOnMain(func() {
		win = newNativeTestWindow(t, server)
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
	win.Show()
	win.Focus()
	select {
	case <-loaded:
	case err := <-failed:
		t.Fatalf("embedded UI load: %s", err)
	case <-time.After(10 * time.Second):
		t.Fatal("embedded UI did not load")
	}
	// The workspace can render before its saved draft has finished loading.
	// Exercise an editable composer, just as a real file drop requires.
	waitNativeDropCondition(t, win, `document.visibilityState==='visible' && document.querySelector('[data-breadcrumb-workspace]')?.textContent === 'workspace' && document.querySelector('textarea[aria-label="Message Pith"]')?.readOnly === false && !document.querySelector('textarea[aria-label="Message Pith"]').disabled`)
	var point struct {
		X int `json:"x"`
		Y int `json:"y"`
	}
	data, err := json.Marshal(nativeDropEval(t, win, `
const input = document.querySelector('textarea[aria-label="Message Pith"]');
Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Review OLD please');input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();input.setSelectionRange(7, 10);
window.__dropReferenceRequests = 0;
const originalFetch = window.fetch;
window.fetch = (...args) => { if (String(args[0]) === '/api/workspace-references') window.__dropReferenceRequests++; return originalFetch.apply(window, args); };
const rect = input.getBoundingClientRect();
return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };`))
	if err != nil || json.Unmarshal(data, &point) != nil {
		t.Fatalf("composer coordinates: %s %v", data, err)
	}
	waitNativeDropCondition(t, win, `document.querySelector('textarea[aria-label="Message Pith"]').value === 'Review OLD please'`)
	if err := forwardNativeFileDrop(win, &mygo.FileDropEvent{Paths: paths, X: point.X, Y: point.Y}); err != nil {
		t.Fatal(err)
	}
	want := "Review `docs/需求 draft.md` `中文 file.txt` please"
	encodedWant, _ := json.Marshal(want)
	waitNativeDropCondition(t, win, `document.querySelector('textarea[aria-label="Message Pith"]').value === `+string(encodedWant))
	t.Logf("native bridge inserted %q through the embedded WebView and authenticated host", want)

	for deadline := time.Now().Add(5 * time.Second); ; {
		if err := forwardNativeFileDrop(win, &mygo.FileDropEvent{Paths: []string{outside}, X: point.X, Y: point.Y}); err != nil {
			t.Fatal(err)
		}
		time.Sleep(100 * time.Millisecond)
		if nativeDropEval(t, win, `document.querySelector('[data-inline-error]')?.textContent.includes('selected workspace')`) == true {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("outside file drop was not rejected")
		}
	}
	if value := nativeDropEval(t, win, `document.querySelector('textarea[aria-label="Message Pith"]').value`); value != want {
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
	if value := nativeDropEval(t, win, `document.querySelector('textarea[aria-label="Message Pith"]').value`); value != want {
		t.Fatalf("drop outside composer changed draft: %v", value)
	}

	// The page cannot read a local path, so the bridge carries a dropped image's
	// bytes to its attachment area; the reference draft stays untouched.
	imagePath := filepath.Join(workspace.Path, "dropped photo.png")
	writeDroppedPNG(t, imagePath)
	if err := forwardNativeFileDrop(win, &mygo.FileDropEvent{Paths: []string{imagePath}, X: point.X, Y: point.Y}); err != nil {
		t.Fatal(err)
	}
	waitNativeDropCondition(t, win, `document.querySelectorAll('[data-draft-image]').length === 1 && document.querySelector('[data-draft-image] img')?.src.startsWith('blob:')`)
	if value := nativeDropEval(t, win, `document.querySelector('textarea[aria-label="Message Pith"]').value`); value != want {
		t.Fatalf("image drop changed the reference draft: %v", value)
	}
	t.Log("native image drop reached the draft attachment area")

	// A file that only looks like an image is reported, not dropped silently.
	fakePath := filepath.Join(workspace.Path, "fake.webp")
	if err := os.WriteFile(fakePath, []byte("not an image"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := forwardNativeFileDrop(win, &mygo.FileDropEvent{Paths: []string{fakePath}, X: point.X, Y: point.Y}); err != nil {
		t.Fatal(err)
	}
	waitNativeDropCondition(t, win, `document.querySelector('[data-inline-error]')?.textContent.includes('fake.webp')`)
	if count := nativeDropEval(t, win, `document.querySelectorAll('[data-draft-image]').length`); count != float64(1) {
		t.Fatalf("rejected image changed the attachments: %v", count)
	}
	for path, expected := range hashes {
		data, err := os.ReadFile(path)
		if err != nil || sha256.Sum256(data) != expected {
			t.Fatalf("drop changed original file %s: %v", path, err)
		}
	}
	t.Log("outside file rejected; drop outside composer ignored; original file SHA-256 hashes unchanged")
}

func nativeDropEval(t *testing.T, win *desktopWindow, code string) any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	value, err := win.Page().EvalContext(ctx, code)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func waitNativeDropCondition(t *testing.T, win *desktopWindow, condition string) {
	t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		if nativeDropEval(t, win, condition) == true {
			return
		}
		time.Sleep(15 * time.Millisecond)
	}
	value := nativeDropEval(t, win, `({focused: document.hasFocus(), visibility: document.visibilityState, frameHeight: document.querySelector('.app-root')?.getBoundingClientRect().height, frameWidth:document.querySelector('.app-root')?.getBoundingClientRect().width, active:document.activeElement.getAttribute('aria-label'),rails:[...document.querySelectorAll('aside')].map(node=>({classes:node.className,inert:node.inert,x:node.getBoundingClientRect().x})), viewportHeight: window.visualViewport?.height, draft: document.querySelector('textarea[aria-label="Message Pith"]')?.value, error: document.querySelector('[data-inline-error]')?.textContent, workspace: document.querySelector('[data-breadcrumb-workspace]')?.textContent, approvalPaths: [...document.querySelectorAll('[data-approval-file] code')].map(node => node.textContent), diffAdd: document.querySelector('[data-diff="add"]')?.textContent, approvalDisabled: [...document.querySelectorAll('[data-approval-card] button')].find(button => button.textContent === 'Allow this action')?.disabled})`)
	t.Fatalf("native UI condition failed (%s): %v", strings.TrimSpace(condition), value)
}
