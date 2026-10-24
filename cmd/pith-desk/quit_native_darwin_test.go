package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo"
	"github.com/minifish-org/pith-desk/internal/desk"
)

func TestQuitNativeSavesDraftBeforeWindowCloses(t *testing.T) {
	if os.Getenv("PITH_DESK_NATIVE_SMOKE") != "1" {
		t.Skip("set PITH_DESK_NATIVE_SMOKE=1 for native quit verification")
	}
	// Quit the child application's real event loop without ending the other native tests.
	if os.Getenv("PITH_DESK_NATIVE_QUIT_CHILD") != "1" {
		executable, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		defer cancel()
		args := []string{"-test.run=^TestQuitNativeSavesDraftBeforeWindowCloses$", "-test.v"}
		if *nativeUIURL != "" {
			args = append(args, "-native-ui-url", *nativeUIURL, "-native-ui-root", *nativeUIRoot)
		}
		command := exec.CommandContext(ctx, executable, args...)
		command.Env = append(os.Environ(), "PITH_DESK_NATIVE_QUIT_CHILD=1", "TMPDIR="+t.TempDir())
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("native quit subprocess: %v\n%s", err, output)
		}
		t.Logf("%s", output)
		return
	}
	service, err := desk.New(filepath.Join(t.TempDir(), "private"))
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	workspace, err := service.AddWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	conversation, err := service.CreateConversation(workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	server, err := startNativeSmokeHost(service)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	var win *desktopWindow
	var exit *quitConfirmation
	var dialogMu sync.Mutex
	mygo.RunOnMain(func() {
		win = newNativeTestWindow(t, server)
		exit = installQuitConfirmation(service, win, &dialogMu)
	})
	defer win.Destroy()
	if err := win.Page().LoadURL(server.URL); err != nil {
		t.Fatal(err)
	}
	win.Show()
	win.Focus()
	waitNativeDropCondition(t, win, `document.querySelector('textarea[aria-label="Message Pith"]')?.readOnly === false && !document.querySelector('textarea[aria-label="Message Pith"]').disabled`)
	nativeDropEval(t, win, `
const original=window.fetch;
window.__quitSaveRequests=0;
window.fetch=async (...args)=>{
  if(String(args[0])==='/api/draft' && args[1]?.method==='POST') {
    window.__quitSaveRequests++;
    const success=await new Promise(resolve=>{window.__finishQuitSave=resolve;});
    if(!success)return Response.json({error:'Exit save unavailable'},{status:503});
  }
  return original(...args);
};
const input=document.querySelector('textarea[aria-label="Message Pith"]');
Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'中'.repeat(2796202)+'ab');
input.dispatchEvent(new Event('input',{bubbles:true}));return true;`)
	closed := make(chan error, 1)
	win.OnClosed(func() {
		draft, err := service.Draft(desk.DraftScope{ID: conversation.ID})
		if err == nil && draft.Text != strings.Repeat("中", desk.MaxDraftBytes/3)+"ab" {
			err = fmt.Errorf("window closed before its last draft reached disk: %d bytes", len(draft.Text))
		}
		closed <- err
	})
	win.Close()
	waitNativeDropCondition(t, win, `window.__quitSaveRequests === 1 && typeof window.__finishQuitSave === 'function'`)
	if win.IsDestroyed() {
		t.Fatal("window closed while its save was pending")
	}
	nativeDropEval(t, win, `window.__finishQuitSave(false);return true;`)
	deadline := time.Now().Add(5 * time.Second)
	for {
		exit.mu.Lock()
		pending := exit.pending
		exit.mu.Unlock()
		if !pending {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("failed exit save did not finish")
		}
		time.Sleep(15 * time.Millisecond)
	}
	if win.IsDestroyed() {
		t.Fatal("failed exit save closed the window")
	}
	if draft, err := service.Draft(desk.DraftScope{ID: conversation.ID}); err != nil || draft.Text != "" {
		t.Fatalf("a failed save changed the stored draft: %d bytes, %v", len(draft.Text), err)
	}
	win.Close()
	waitNativeDropCondition(t, win, `window.__quitSaveRequests === 2`)
	nativeDropEval(t, win, `window.__finishQuitSave(true);return true;`)
	select {
	case err := <-closed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("successful retry did not close the native window")
	}
	t.Log("real close waited for the draft, failed save kept the window open, retry reached disk before OnClosed")
}
