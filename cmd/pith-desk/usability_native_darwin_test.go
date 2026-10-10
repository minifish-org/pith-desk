package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/egoist/mygo"
	"github.com/minifish-org/pith-desk/internal/desk"
	"github.com/minifish-org/pith-desk/internal/host"
)

// All requests go to a deterministic local provider. The test exercises the
// real WKWebView, embedded UI, authenticated host and private data on restart.
func TestUsabilityNativeDraftApprovalAndFilePreviews(t *testing.T) {
	if os.Getenv("PITH_DESK_NATIVE_SMOKE") != "1" {
		t.Skip("set PITH_DESK_NATIVE_SMOKE=1 for native usability verification")
	}
	var requests atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		n := requests.Add(1)
		if n%2 == 1 {
			args := map[string]any{"path": "note.md", "content": "# Native preview\n\n**Saved Markdown**\n\n<script>window.__previewUnsafe=true</script><img src=https://example.invalid/track>"}
			name := "write_file"
			if n == 3 {
				name = "edit_file"
				args = map[string]any{"path": "note.md", "edits": []any{map[string]string{"oldText": "Saved Markdown", "newText": "Edited Markdown"}}}
			}
			encoded, _ := json.Marshal(args)
			calls := []any{map[string]any{"index": 0, "id": fmt.Sprintf("file-%d", n), "type": "function", "function": map[string]string{"name": name, "arguments": string(encoded)}}}
			if n == 1 {
				for index, file := range []struct{ path, content string }{{"picture.png", "Image placeholder"}, {"result.txt", "Plain text 中文"}, {"animation.html", "<script>window.__previewUnsafe=true</script>"}} {
					arguments, _ := json.Marshal(map[string]string{"path": file.path, "content": file.content})
					calls = append(calls, map[string]any{"index": index + 1, "id": fmt.Sprintf("extra-%d", index), "type": "function", "function": map[string]string{"name": "write_file", "arguments": string(arguments)}})
				}
			}
			chunk := map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "tool_calls": calls}}}}
			data, _ := json.Marshal(chunk)
			fmt.Fprintf(w, "data: %s\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n", data)
		} else {
			fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"File saved.\"}}]}\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
		}
		w.(http.Flusher).Flush()
	}))
	defer provider.Close()
	dataDir, workspacePath := t.TempDir(), t.TempDir()
	service, err := desk.New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { service.Close() }()
	workspace, err := service.AddWorkspace(workspacePath)
	if err != nil {
		t.Fatal(err)
	}
	first, err := service.CreateConversation(workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.CreateConversation(workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.OpenConversation(first.ID); err != nil {
		t.Fatal(err)
	}
	if err := service.Configure(desk.ConfigInput{BaseURL: provider.URL + "/v1", Model: "deepseek-flash", APIKey: "fixture-key"}); err != nil {
		t.Fatal(err)
	}
	server, err := host.Start(service, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = server.Close() }()
	var win *mygo.Window
	mygo.RunOnMain(func() {
		win = mygo.NewWindow(mygo.WindowOptions{Title: "Pith Desk usability smoke", Hidden: true, Width: 1320, Height: 860})
	})
	defer win.Destroy()
	defer func() {
		if t.Failed() {
			state := service.Snapshot()
			draft, draftErr := service.Draft(desk.DraftScope{ID: first.ID})
			t.Logf("saved draft: %+v, error: %v", draft, draftErr)
			t.Logf("fixture requests=%d running=%v phase=%s error=%q hasKey=%v approval=%+v", requests.Load(), state.Running, state.Runtime.Phase, state.Error, state.Settings.HasAPIKey, state.PendingApproval)
			t.Logf("UI: %v", nativeDropEval(t, win, `({ready:document.querySelector('#composer-input')?.readOnly, sendDisabled:document.querySelector('#send-button')?.disabled, approval:document.querySelector('#approval')?.textContent, failure:document.querySelector('#task-failure')?.textContent, error:document.querySelector('#inline-error')?.textContent, loaded:document.querySelector('#composer-input')?.placeholder})`))
		}
	}()
	if err := win.Page().LoadURL(server.URL); err != nil {
		t.Fatal(err)
	}
	waitNativeDropCondition(t, win, `document.querySelector('#composer-input')?.readOnly === false && document.querySelector('#workspace-label')?.textContent !== 'No workspace'`)
	nativeDropEval(t, win, `const input = document.querySelector('#composer-input'); input.value = 'First draft 中文'; input.dispatchEvent(new Event('input', {bubbles:true})); return true;`)
	if err := service.OpenConversation(second.ID); err != nil {
		t.Fatal(err)
	}
	waitNativeDropCondition(t, win, `document.querySelector('#composer-input').value === '' && !document.querySelector('#composer-input').readOnly`)
	nativeDropEval(t, win, `const input = document.querySelector('#composer-input'); input.value = 'Second draft'; input.dispatchEvent(new Event('input', {bubbles:true})); return true;`)
	if err := service.OpenConversation(first.ID); err != nil {
		t.Fatal(err)
	}
	waitNativeDropCondition(t, win, `document.querySelector('#composer-input').value === 'First draft 中文'`)
	waitSavedDraft(t, service, first.ID, "First draft 中文")
	waitSavedDraft(t, service, second.ID, "Second draft")
	// Recreate the host on a different random origin to verify profile storage.
	if err := server.Close(); err != nil {
		t.Fatal(err)
	}
	service.Close()
	service, err = desk.New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	server, err = host.Start(service, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := win.Page().LoadURL(server.URL); err != nil {
		t.Fatal(err)
	}
	newOrigin, _ := json.Marshal(server.URL)
	waitNativeDropCondition(t, win, `location.origin === `+string(newOrigin)+` && document.querySelector('#composer-input')?.value === 'First draft 中文' && !document.querySelector('#composer-input').readOnly`)
	nativeDropEval(t, win, `document.querySelector('#composer-form').requestSubmit(); return true;`)
	waitNativeDropCondition(t, win, `document.querySelector('.approval-diff .diff-add') !== null`)
	saveUsabilityScreenshot(t, win, "approval-diff.png")
	waitSavedDraft(t, service, first.ID, "")
	approved := map[string]bool{}
	previousID := ""
	for range 4 {
		encodedID, _ := json.Marshal(previousID)
		waitNativeDropCondition(t, win, `document.querySelector('.approval-diff .diff-add') !== null && document.querySelector('[data-approval="allow"]')?.dataset.approvalId !== `+string(encodedID))
		value := nativeDropEval(t, win, `({path:document.querySelector('.approval-file code').textContent, id:document.querySelector('[data-approval="allow"]').dataset.approvalId})`)
		encoded, _ := json.Marshal(value)
		var approval struct{ Path, ID string }
		if err := json.Unmarshal(encoded, &approval); err != nil {
			t.Fatal(err)
		}
		if approved[approval.Path] || !map[string]bool{"note.md": true, "picture.png": true, "result.txt": true, "animation.html": true}[approval.Path] {
			t.Fatalf("unexpected approval: %+v", approval)
		}
		if _, err := os.Stat(filepath.Join(workspacePath, approval.Path)); !os.IsNotExist(err) {
			t.Fatalf("%s existed before its approval", approval.Path)
		}
		approved[approval.Path], previousID = true, approval.ID
		nativeDropEval(t, win, `document.querySelector('[data-approval="allow"]').click(); return true;`)
	}
	waitNativeDropCondition(t, win, `document.querySelectorAll('[data-preview-path]').length === 4`)
	nativeDropEval(t, win, `document.querySelector('#artifacts').open = true; document.querySelector('#artifacts').scrollIntoView({block:'end'}); return true;`)
	saveUsabilityScreenshot(t, win, "generated-file-actions.png")
	nativeDropEval(t, win, `document.querySelector('[data-preview-path$="note.md"]').click(); return true;`)
	waitNativeDropCondition(t, win, `document.querySelector('#preview-dialog').open && document.querySelector('#file-preview-body h1')?.textContent === 'Native preview'`)
	saveUsabilityScreenshot(t, win, "markdown-preview.png")
	if nativeDropEval(t, win, `window.__previewUnsafe !== true && document.querySelectorAll('#file-preview-body script, #file-preview-body img').length === 0 && document.querySelector('#file-preview-body strong')?.textContent === 'Saved Markdown'`) != true {
		t.Fatal("Markdown preview failed sanitization")
	}
	var imageData bytes.Buffer
	if err := png.Encode(&imageData, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspacePath, "picture.png"), imageData.Bytes(), 0644); err != nil {
		t.Fatal(err)
	}
	nativeDropEval(t, win, `document.querySelector('[data-close="preview-dialog"]').click(); document.querySelector('[data-preview-path$="picture.png"]').click(); return true;`)
	waitNativeDropCondition(t, win, `document.querySelector('#file-preview-body img')?.naturalWidth === 2`)
	nativeDropEval(t, win, `document.querySelector('[data-close="preview-dialog"]').click(); document.querySelector('[data-preview-path$="result.txt"]').click(); return true;`)
	waitNativeDropCondition(t, win, `document.querySelector('.file-preview-text')?.textContent === 'Plain text 中文'`)
	nativeDropEval(t, win, `document.querySelector('[data-close="preview-dialog"]').click(); document.querySelector('[data-preview-path$="animation.html"]').click(); return true;`)
	waitNativeDropCondition(t, win, `document.querySelector('.file-preview-text')?.textContent.includes('<script>window.__previewUnsafe=true</script>')`)
	if nativeDropEval(t, win, `window.__previewUnsafe !== true && document.querySelectorAll('#file-preview-body script').length === 0`) != true {
		t.Fatal("HTML source executed in preview")
	}
	nativeDropEval(t, win, `document.querySelector('[data-close="preview-dialog"]').click(); const input=document.querySelector('#composer-input'); input.value='Edit it'; input.dispatchEvent(new Event('input', {bubbles:true})); document.querySelector('#composer-form').requestSubmit(); return true;`)
	waitNativeDropCondition(t, win, `document.querySelector('.approval-diff .diff-remove')?.textContent.includes('Saved Markdown') && document.querySelector('.approval-diff .diff-add')?.textContent.includes('Edited Markdown')`)
	nativeDropEval(t, win, `document.querySelector('[data-approval="allow"]').click(); return true;`)
	waitNativeDropCondition(t, win, `document.querySelector('[data-preview-path]') !== null && document.querySelector('#approval').textContent === ''`)
	content, err := os.ReadFile(filepath.Join(workspacePath, "note.md"))
	if err != nil || !strings.Contains(string(content), "Edited Markdown") {
		t.Fatalf("approved edit not applied: %s %v", content, err)
	}
	// Reload immediately, before the autosave debounce can expire. The old
	// document's authenticated unload save must preserve the latest text.
	nativeDropEval(t, win, `const input=document.querySelector('#composer-input'); input.value='Last text before reload'; input.dispatchEvent(new Event('input', {bubbles:true})); return true;`)
	if err := win.Page().LoadURL(server.URL + "?restore-draft"); err != nil {
		t.Fatal(err)
	}
	waitNativeDropCondition(t, win, `location.search === '?restore-draft' && document.querySelector('#composer-input')?.value === 'Last text before reload' && !document.querySelector('#composer-input').readOnly`)
	waitSavedDraft(t, service, first.ID, "Last text before reload")
	// The production quit guard saves before the host and WebView go away,
	// including keystrokes still waiting for the normal autosave debounce.
	nativeDropEval(t, win, `const input=document.querySelector('#composer-input'); input.value='Last text before quit'; input.dispatchEvent(new Event('input', {bubbles:true})); return true;`)
	if err := flushDesktopDrafts(win); err != nil {
		t.Fatal(err)
	}
	waitSavedDraft(t, service, first.ID, "Last text before quit")
	t.Log("drafts survived conversation switches, immediate reload and a new host origin; native exit saved the last keystrokes; send cleared only its draft; real write/edit approvals rendered SDK diffs; PNG, Markdown and UTF-8 text previews loaded; HTML and Markdown scripts remained inert")
}

func TestUsabilityNativeInitialDraftRejectedSend(t *testing.T) {
	if os.Getenv("PITH_DESK_NATIVE_SMOKE") != "1" {
		t.Skip("set PITH_DESK_NATIVE_SMOKE=1 for native usability verification")
	}
	service, err := desk.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	if _, err := service.AddWorkspace(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if err := service.Configure(desk.ConfigInput{BaseURL: "http://127.0.0.1:1/v1", Model: "deepseek-flash", APIKey: "fixture-key"}); err != nil {
		t.Fatal(err)
	}
	server, err := host.Start(service, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	var win *mygo.Window
	mygo.RunOnMain(func() {
		win = mygo.NewWindow(mygo.WindowOptions{Title: "Pith Desk initial draft smoke", Hidden: true, Width: 1320, Height: 860})
	})
	defer win.Destroy()
	if err := flushDesktopDrafts(win); err != nil {
		t.Fatalf("an unloaded interface prevented exit: %v", err)
	}
	if err := win.Page().LoadURL(server.URL); err != nil {
		t.Fatal(err)
	}
	waitNativeDropCondition(t, win, `document.querySelector('#composer-input')?.readOnly === false && document.querySelector('#workspace-label')?.textContent !== 'No workspace'`)
	// Reject only the first send; conversation creation and draft persistence
	// still use the real authenticated host. No provider request is sent.
	nativeDropEval(t, win, `const originalFetch=window.fetch; window.fetch=(url,options)=> {
  if (String(url)==='/api/send') { window.fetch=originalFetch; return Promise.resolve(new Response(JSON.stringify({error:'This send was rejected'}), {status:409, headers:{'Content-Type':'application/json'}})); }
  return originalFetch(url,options);
}; const input=document.querySelector('#composer-input'); input.value='Keep my first draft 中文'; input.dispatchEvent(new Event('input', {bubbles:true})); document.querySelector('#composer-form').requestSubmit(); return true;`)
	waitNativeDropCondition(t, win, `document.querySelector('#inline-error')?.textContent.includes('This send was rejected') && document.querySelector('#composer-input')?.value === 'Keep my first draft 中文' && !document.querySelector('#composer-input').readOnly`)
	id := service.Snapshot().ActiveID
	if id == "" || len(service.Snapshot().Conversations) != 1 {
		t.Fatal("first send did not create its conversation")
	}
	waitSavedDraft(t, service, id, "Keep my first draft 中文")
	if err := win.Page().LoadURL(server.URL + "?rejected-send"); err != nil {
		t.Fatal(err)
	}
	waitNativeDropCondition(t, win, `location.search === '?rejected-send' && document.querySelector('#composer-input')?.value === 'Keep my first draft 中文' && !document.querySelector('#composer-input').readOnly`)
}

func saveUsabilityScreenshot(t *testing.T, win *mygo.Window, name string) {
	t.Helper()
	dir := os.Getenv("PITH_DESK_NATIVE_SCREENSHOTS")
	if dir == "" {
		return
	}
	data, err := win.CapturePage()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), data, 0600); err != nil {
		t.Fatal(err)
	}
}

func waitSavedDraft(t *testing.T, service *desk.Service, id, text string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		draft, err := service.Draft(desk.DraftScope{ID: id})
		if err == nil && draft.Text == text {
			return
		}
		time.Sleep(15 * time.Millisecond)
	}
	t.Fatalf("draft wasn't saved for %s", id)
}
