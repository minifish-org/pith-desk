package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"hash/crc32"
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
	server, err := startNativeSmokeHost(service)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = server.Close() }()
	var win *desktopWindow
	mygo.RunOnMain(func() {
		win = newNativeTestWindow(t, server)
	})
	defer win.Destroy()
	defer func() {
		if t.Failed() {
			state := service.Snapshot()
			draft, draftErr := service.Draft(desk.DraftScope{ID: first.ID})
			t.Logf("saved draft bytes=%d revision=%d, error: %v", len(draft.Text), draft.Revision, draftErr)
			t.Logf("fixture requests=%d running=%v phase=%s error=%q hasKey=%v approval=%+v", requests.Load(), state.Running, state.Runtime.Phase, state.Error, state.Settings.HasAPIKey, state.PendingApproval)
			t.Logf("UI: %v", nativeDropEval(t, win, `({ready:document.querySelector('textarea[aria-label="Message Pith"]')?.readOnly, sendDisabled:document.querySelector('form[data-composer] button[type=submit]')?.disabled, approval:document.querySelector('[data-approval-card]')?.textContent, failure:document.querySelector('[data-task-failure]')?.textContent, error:document.querySelector('[data-inline-error]')?.textContent, loaded:document.querySelector('textarea[aria-label="Message Pith"]')?.placeholder})`))
		}
	}()
	if err := win.Page().LoadURL(server.URL); err != nil {
		t.Fatal(err)
	}
	win.Show()
	win.Focus()
	waitNativeDropCondition(t, win, `document.visibilityState === 'visible' && document.querySelector('textarea[aria-label="Message Pith"]')?.readOnly === false && document.querySelector('[data-breadcrumb-workspace]')?.textContent !== 'No workspace'`)
	nativeDropEval(t, win, `const input = document.querySelector('textarea[aria-label="Message Pith"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'First draft 中文'); input.dispatchEvent(new Event('input', {bubbles:true})); return true;`)
	nativeDropEval(t, win, `const canvas=document.createElement('canvas'); canvas.width=10; canvas.height=10; const bytes=Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), c=>c.charCodeAt(0)); const transfer=new DataTransfer(); transfer.items.add(new File([bytes], 'draft.png', {type:'image/png'})); const picker=document.querySelector('form[data-composer] input[type=file]'); picker.files=transfer.files; picker.dispatchEvent(new Event('change', {bubbles:true})); return true;`)
	waitNativeDropCondition(t, win, `document.querySelectorAll('[data-draft-image]').length === 1`)

	if err := service.OpenConversation(second.ID); err != nil {
		t.Fatal(err)
	}
	waitNativeDropCondition(t, win, `document.querySelector('textarea[aria-label="Message Pith"]').value === '' && !document.querySelector('textarea[aria-label="Message Pith"]').readOnly`)
	nativeDropEval(t, win, `const input = document.querySelector('textarea[aria-label="Message Pith"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Second draft'); input.dispatchEvent(new Event('input', {bubbles:true})); return true;`)
	if err := service.OpenConversation(first.ID); err != nil {
		t.Fatal(err)
	}
	waitNativeDropCondition(t, win, `document.querySelector('textarea[aria-label="Message Pith"]').value === 'First draft 中文' && document.querySelectorAll('[data-draft-image]').length === 1`)
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
	server, err = startNativeSmokeHost(service)
	if err != nil {
		t.Fatal(err)
	}
	if err := win.Page().LoadURL(server.URL); err != nil {
		t.Fatal(err)
	}
	newOrigin, _ := json.Marshal(server.URL)
	waitNativeDropCondition(t, win, `location.origin === `+string(newOrigin)+` && document.querySelector('textarea[aria-label="Message Pith"]')?.value === 'First draft 中文' && !document.querySelector('textarea[aria-label="Message Pith"]').readOnly && document.querySelectorAll('[data-draft-image]').length === 1`)
	nativeDropEval(t, win, `document.querySelector('[data-draft-images] button[aria-label^="Remove "]').click(); document.querySelector('form[data-composer]').requestSubmit(); return true;`)
	waitNativeDropCondition(t, win, `document.querySelector('[data-diff="add"]') !== null`)
	saveUsabilityScreenshot(t, win, "approval-diff.png")
	waitSavedDraft(t, service, first.ID, "")
	approved := map[string]bool{}
	previousID := ""
	for range 4 {
		approval := waitNativeApproval(t, win, service, previousID)
		path := approval.Preview.Path
		if approved[path] || !map[string]bool{"note.md": true, "picture.png": true, "result.txt": true, "animation.html": true}[path] {
			t.Fatalf("unexpected approval: %+v", approval)
		}
		if _, err := os.Stat(filepath.Join(workspacePath, path)); !os.IsNotExist(err) {
			t.Fatalf("%s existed before its approval", path)
		}
		approved[path], previousID = true, approval.ID
		nativeDropEval(t, win, `[...document.querySelectorAll('[data-approval-card] button')].find(button => button.textContent === 'Allow this action').click(); return true;`)
	}
	nativeDropEval(t, win, `document.querySelector('[data-edited-files]')?.scrollIntoView({block:'end'}); return true;`)
	waitNativeDropCondition(t, win, `document.querySelectorAll('[data-edited-files] [data-edited-file]').length === 4`)
	saveUsabilityScreenshot(t, win, "generated-file-actions.png")
	openNativePreview(t, win, "note.md")
	waitNativeDropCondition(t, win, `document.querySelector('[data-file-preview-modal] h1')?.textContent === 'Native preview'`)
	saveUsabilityScreenshot(t, win, "markdown-preview.png")
	if nativeDropEval(t, win, `window.__previewUnsafe !== true && document.querySelectorAll('[data-file-preview-body] script, [data-file-preview-body] img').length === 0 && document.querySelector('[data-file-preview-body] strong')?.textContent === 'Saved Markdown'`) != true {
		t.Fatal("Markdown preview failed sanitization")
	}
	var imageData bytes.Buffer
	if err := png.Encode(&imageData, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	// A valid private ancillary PNG chunk exercises images above the former
	// 8 MiB ceiling without a huge decoded pixel allocation.
	chunk := make([]byte, (10<<20)+12)
	binary.BigEndian.PutUint32(chunk[:4], 10<<20)
	copy(chunk[4:8], "piTH")
	binary.BigEndian.PutUint32(chunk[len(chunk)-4:], crc32.ChecksumIEEE(chunk[4:len(chunk)-4]))
	imageBytes := imageData.Bytes()
	largeImage := append(append(append([]byte{}, imageBytes[:len(imageBytes)-12]...), chunk...), imageBytes[len(imageBytes)-12:]...)
	if err := os.WriteFile(filepath.Join(workspacePath, "picture.png"), largeImage, 0644); err != nil {
		t.Fatal(err)
	}
	openNativePreview(t, win, "picture.png")
	waitNativeDropCondition(t, win, `document.querySelector('[data-file-preview-body] img')?.naturalWidth === 2`)
	openNativePreview(t, win, "result.txt")
	waitNativeDropCondition(t, win, `document.querySelector('[data-file-preview-body] [data-file-preview-text]')?.textContent === 'Plain text 中文'`)
	largeText := "PREVIEW START\n" + strings.Repeat("中文🙂\n", (8<<20)/11-4) + "\nPREVIEW END"
	if err := os.WriteFile(filepath.Join(workspacePath, "result.txt"), []byte(largeText), 0644); err != nil {
		t.Fatal(err)
	}
	openNativePreview(t, win, "result.txt")
	waitNativeDropCondition(t, win, `document.querySelector('[data-file-preview-body] [data-preview-pagination]') !== null && document.querySelector('[data-file-preview-body] [data-file-preview-text]')?.textContent.startsWith('PREVIEW START')`)
	if nativeDropEval(t, win, `new TextEncoder().encode(document.querySelector('[data-file-preview-body] [data-file-preview-text]').textContent).length <= 256*1024`) != true {
		t.Fatal("large preview rendered all bytes at once")
	}
	for deadline := time.Now().Add(5 * time.Second); ; {
		if nativeDropEval(t, win, `(() => {const next=document.querySelector('[data-file-preview-body] [data-preview-pagination] button:last-child');if(!next)return false;if(next.disabled)return true;next.click();return false})()`) == true {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("large preview pagination did not finish")
		}
		time.Sleep(30 * time.Millisecond)
	}
	waitNativeDropCondition(t, win, `document.querySelector('[data-file-preview-body] [data-file-preview-text]')?.textContent.endsWith('PREVIEW END')`)
	saveUsabilityScreenshot(t, win, "large-text-preview.png")
	openNativePreview(t, win, "animation.html")
	waitNativeDropCondition(t, win, `document.querySelector('[data-file-preview-body] [data-file-preview-text]')?.textContent.includes('<script>window.__previewUnsafe=true</script>')`)
	if nativeDropEval(t, win, `window.__previewUnsafe !== true && document.querySelectorAll('[data-file-preview-body] script').length === 0`) != true {
		t.Fatal("HTML source executed in preview")
	}
	nativeDropEval(t, win, `document.querySelector('[data-file-preview-modal] [data-slot="dialog-close"]').click(); const input=document.querySelector('textarea[aria-label="Message Pith"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Edit it'); input.dispatchEvent(new Event('input', {bubbles:true})); document.querySelector('form[data-composer]').requestSubmit(); return true;`)
	waitNativeDropCondition(t, win, `document.querySelector('[data-diff="remove"]')?.textContent.includes('Saved Markdown') && document.querySelector('[data-diff="add"]')?.textContent.includes('Edited Markdown')`)
	nativeDropEval(t, win, `[...document.querySelectorAll('[data-approval-card] button')].find(button => button.textContent === 'Allow this action').click(); return true;`)
	waitNativeDropCondition(t, win, `document.querySelector('[data-approval-card]') === null`)
	nativeDropEval(t, win, `document.querySelector('[data-edited-files]')?.scrollIntoView({block:'end'}); return true;`)
	waitNativeDropCondition(t, win, `document.querySelector('[data-edited-files] [data-edited-file]') !== null`)
	content, err := os.ReadFile(filepath.Join(workspacePath, "note.md"))
	if err != nil || !strings.Contains(string(content), "Edited Markdown") {
		t.Fatalf("approved edit not applied: %s %v", content, err)
	}
	// Reload immediately, before the autosave debounce can expire. The old
	// document's authenticated unload save must preserve the latest text.
	nativeDropEval(t, win, `const input=document.querySelector('textarea[aria-label="Message Pith"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Last text before reload'); input.dispatchEvent(new Event('input', {bubbles:true})); return true;`)
	if err := win.Page().LoadURL(server.URL + "?restore-draft"); err != nil {
		t.Fatal(err)
	}
	waitNativeDropCondition(t, win, `location.search === '?restore-draft' && document.querySelector('textarea[aria-label="Message Pith"]')?.value === 'Last text before reload' && !document.querySelector('textarea[aria-label="Message Pith"]').readOnly`)
	waitSavedDraft(t, service, first.ID, "Last text before reload")
	// The production quit guard saves before the host and WebView go away,
	// including keystrokes still waiting for the normal autosave debounce.
	nativeDropEval(t, win, `const input=document.querySelector('textarea[aria-label="Message Pith"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'中'.repeat(2796202)+'ab'); input.dispatchEvent(new Event('input', {bubbles:true})); return true;`)
	if err := flushDesktopDrafts(win); err != nil {
		t.Fatal(err)
	}
	waitSavedDraft(t, service, first.ID, strings.Repeat("中", desk.MaxDraftBytes/3)+"ab")
	t.Log("text and image drafts survived conversation switches, immediate reload and a new host origin; native exit saved the last keystrokes; send cleared only its draft; real write/edit approvals rendered SDK diffs; PNG, Markdown and UTF-8 text previews loaded; HTML and Markdown scripts remained inert")
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
	server, err := startNativeSmokeHost(service)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	var win *desktopWindow
	mygo.RunOnMain(func() {
		win = newNativeTestWindow(t, server)
	})
	defer win.Destroy()
	if err := flushDesktopDrafts(win); err != nil {
		t.Fatalf("an unloaded interface prevented exit: %v", err)
	}
	if err := win.Page().LoadURL(server.URL); err != nil {
		t.Fatal(err)
	}
	win.Show()
	win.Focus()
	waitNativeDropCondition(t, win, `document.visibilityState === 'visible' && document.querySelector('textarea[aria-label="Message Pith"]')?.readOnly === false && document.querySelector('[data-breadcrumb-workspace]')?.textContent !== 'No workspace'`)
	// Reject only the first send; conversation creation and draft persistence
	// still use the real authenticated host. No provider request is sent.
	nativeDropEval(t, win, `const originalFetch=window.fetch; window.fetch=(url,options)=> {
  if (String(url)==='/api/send') { window.fetch=originalFetch; return Promise.resolve(new Response(JSON.stringify({error:'This send was rejected'}), {status:409, headers:{'Content-Type':'application/json'}})); }
  return originalFetch(url,options);
}; const input=document.querySelector('textarea[aria-label="Message Pith"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Keep my first draft 中文'); input.dispatchEvent(new Event('input', {bubbles:true})); document.querySelector('form[data-composer]').requestSubmit(); return true;`)
	waitNativeDropCondition(t, win, `document.querySelector('[data-inline-error]')?.textContent.includes('This send was rejected') && document.querySelector('textarea[aria-label="Message Pith"]')?.value === 'Keep my first draft 中文' && !document.querySelector('textarea[aria-label="Message Pith"]').readOnly`)
	id := service.Snapshot().ActiveID
	if id == "" || len(service.Snapshot().Conversations) != 1 {
		t.Fatal("first send did not create its conversation")
	}
	waitSavedDraft(t, service, id, "Keep my first draft 中文")
	if err := win.Page().LoadURL(server.URL + "?rejected-send"); err != nil {
		t.Fatal(err)
	}
	waitNativeDropCondition(t, win, `location.search === '?rejected-send' && document.querySelector('textarea[aria-label="Message Pith"]')?.value === 'Keep my first draft 中文' && !document.querySelector('textarea[aria-label="Message Pith"]').readOnly`)
}

func openNativePreview(t *testing.T, win *desktopWindow, name string) {
	t.Helper()
	encoded, _ := json.Marshal(name)
	nativeDropEval(t, win, `document.querySelector('[data-file-preview-modal] [data-slot="dialog-close"]')?.click(); return true;`)
	waitNativeDropCondition(t, win, `!document.querySelector('[data-file-preview-modal]')`)
	deadline := time.Now().Add(5 * time.Second)
	for {
		if nativeDropEval(t, win, `document.querySelector('[data-tools-rail]')?.getBoundingClientRect().width>200`) == true {
			break
		}
		nativeDropEval(t, win, `document.querySelector('button[aria-label="Toggle tools"]')?.click();return true;`)
		if time.Now().After(deadline) {
			t.Fatal("native tools did not open for a file preview")
		}
		time.Sleep(30 * time.Millisecond)
	}
	nativeDropEval(t, win, `document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return true;`)
	openNativeFilesTab(t, win)
	nativeDropEval(t, win, `document.querySelector('[data-tools-rail] button[aria-label="Refresh workspace files"]')?.click();return true;`)
	waitNativeDropCondition(t, win, `[...document.querySelectorAll('[data-tools-rail] button')].some(button=>button.textContent.trim()===`+string(encoded)+`)`)
	nativeDropEval(t, win, `[...document.querySelectorAll('[data-tools-rail] button')].find(button=>button.textContent.trim()===`+string(encoded)+`).click();return true;`)
}

func openNativeFilesTab(t *testing.T, win *desktopWindow) {
	t.Helper()
	waitNativeDropCondition(t, win, `[...document.querySelectorAll('[data-tools-rail] button')].some(button=>button.textContent.trim()==='Open files') || [...document.querySelectorAll('[data-tools-rail] [role="tab"]')].some(tab=>tab.textContent.trim()==='Files')`)
	nativeDropEval(t, win, `const tab=[...document.querySelectorAll('[data-tools-rail] [role="tab"]')].find(tab=>tab.textContent.trim()==='Files');if(tab)tab.click();else [...document.querySelectorAll('[data-tools-rail] button')].find(button=>button.textContent.trim()==='Open files').click();return true;`)
	waitNativeDropCondition(t, win, `[...document.querySelectorAll('[data-tools-rail] [role="tab"][aria-selected="true"]')].some(tab=>tab.textContent.trim()==='Files')`)
}

func waitNativeApproval(t *testing.T, win *desktopWindow, service *desk.Service, previousID string) *desk.Approval {
	t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		approval := service.Snapshot().PendingApproval
		if approval != nil && approval.ID != previousID && approval.Preview != nil {
			path, _ := json.Marshal(approval.Preview.Path)
			waitNativeDropCondition(t, win, `document.querySelector('[data-approval-file] code')?.textContent === `+string(path)+` && document.querySelector('[data-diff="add"]') !== null && [...document.querySelectorAll('[data-approval-card] button')].find(button => button.textContent === 'Allow this action')?.disabled === false`)
			return approval
		}
		time.Sleep(15 * time.Millisecond)
	}
	t.Fatal("next native approval did not arrive")
	return nil
}

func saveUsabilityScreenshot(t *testing.T, win *desktopWindow, name string) {
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
