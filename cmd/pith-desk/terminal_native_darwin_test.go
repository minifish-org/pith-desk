package main

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/egoist/mygo"
	"github.com/minifish-org/pith-desk/internal/desk"
	"github.com/minifish-org/pith-desk/internal/testsupport/shellfixture"
)

func TestTerminalNativeShellReconnectToolsAndDraft(t *testing.T) {
	if os.Getenv("PITH_DESK_NATIVE_SMOKE") != "1" {
		t.Skip("set PITH_DESK_NATIVE_SMOKE=1 for native terminal acceptance")
	}
	shell, err := shellfixture.Create(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("SHELL", shell)
	service, err := desk.New(t.TempDir())
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
	if _, err = service.SaveDraft(desk.DraftInput{DraftScope: desk.DraftScope{ID: conversation.ID}, Draft: desk.Draft{Text: "Native draft 中文", Revision: 1}}); err != nil {
		t.Fatal(err)
	}
	server, err := startNativeSmokeHost(service)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	var win *mygo.Window
	mygo.RunOnMain(func() {
		opts := desktopWindowOptions()
		opts.Title = "Pith Desk terminal smoke"
		opts.StateKey = ""
		opts.Hidden = true
		win = mygo.NewWindow(opts)
	})
	defer win.Destroy()
	if err = win.Page().LoadURL(server.URL); err != nil {
		t.Fatal(err)
	}
	win.Show()
	win.Focus()
	show := func() {
		waitNativeDropCondition(t, win, `!!document.querySelector('textarea[aria-label="Message Pith"]') && !document.querySelector('textarea[aria-label="Message Pith"]').readOnly`)
		nativeDropEval(t, win, `document.querySelector('button[aria-label="Toggle tools"]').click();[...document.querySelectorAll('.pui-tools button')].find(b=>b.textContent==='Terminal').click();return true;`)
	}
	show()
	waitNativeDropCondition(t, win, `[...document.querySelectorAll('.pui-tools button')].some(b=>!b.hidden && b.textContent==='Start terminal' && !b.disabled)`)
	nativeDropEval(t, win, `[...document.querySelectorAll('.pui-tools button')].find(b=>b.textContent==='Start terminal').click();return true;`)
	enter := func(text string) {
		t.Log("native terminal input:", text)
		waitNativeDropCondition(t, win, `!!document.querySelector('.pui-tools textarea[aria-label="Terminal input"]') && document.querySelector('.pui-tools').textContent.includes('Connected · manual shell')`)
		nativeDropEval(t, win, `const input=document.querySelector('.pui-tools textarea[aria-label="Terminal input"]');input.focus();input.value=`+strconv.Quote(text)+`;input.dispatchEvent(new InputEvent('input',{data:`+strconv.Quote(text)+`,inputType:'insertText',bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));return true;`)
	}
	enter(`stty -echo; echo $$ > first.pid; printf '\033[32mNative 中文\033[0m\n'; echo ready > native-ready`)
	path := filepath.Join(workspace.Path, "native-ready")
	for deadline := time.Now().Add(5 * time.Second); ; {
		data, _ := os.ReadFile(path)
		if string(data) == "ready\n" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("native terminal did not execute input")
		}
		time.Sleep(20 * time.Millisecond)
	}
	waitNativeDropCondition(t, win, `document.querySelector('[aria-label="Terminal display"]').textContent.includes('Native 中文')`)
	nativeDropEval(t, win, `[...document.querySelectorAll('.pui-tools button')].find(b=>b.textContent==='Files').click();document.querySelector('button[aria-label="Refresh workspace files"]').click();return true;`)
	waitNativeDropCondition(t, win, `[...document.querySelectorAll('.pui-tools .pui-history-item')].some(b=>b.textContent==='native-ready')`)
	nativeDropEval(t, win, `window.__terminalOldDocument=true;return true;`)
	if err = win.Page().LoadURL(server.URL); err != nil {
		t.Fatal(err)
	}
	waitNativeDropCondition(t, win, `!window.__terminalOldDocument && !!document.querySelector('textarea[aria-label="Message Pith"]')`)
	show()
	waitNativeDropCondition(t, win, `document.querySelector('[aria-label="Terminal display"]').textContent.includes('Native 中文')`)
	enter(`echo $$ > after-refresh.pid; sleep 60`)
	waitNativeDropCondition(t, win, `document.querySelector('.pui-tools').textContent.includes('Connected · manual shell')`)
	time.Sleep(100 * time.Millisecond)
	nativeDropEval(t, win, `document.querySelector('button[aria-label="Interrupt terminal"]').click();return true;`)
	enter(`echo interrupted > native-interrupted`)
	for deadline := time.Now().Add(5 * time.Second); ; {
		data, _ := os.ReadFile(filepath.Join(workspace.Path, "native-interrupted"))
		if string(data) == "interrupted\n" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("native interrupt did not release foreground program")
		}
		time.Sleep(20 * time.Millisecond)
	}
	first, _ := os.ReadFile(filepath.Join(workspace.Path, "first.pid"))
	second, _ := os.ReadFile(filepath.Join(workspace.Path, "after-refresh.pid"))
	if len(first) == 0 || string(first) != string(second) {
		t.Fatal("native refresh replaced shell")
	}
	if value := nativeDropEval(t, win, `return document.querySelector('textarea[aria-label="Message Pith"]').value;`); value != "Native draft 中文" {
		t.Fatal("terminal changed native draft", value)
	}
	win.Show()
	win.Focus()
	waitNativeDropCondition(t, win, `document.visibilityState==='visible'`)
	nativeDropEval(t, win, `window.__terminalPainted=false;requestAnimationFrame(()=>requestAnimationFrame(()=>window.__terminalPainted=true));return true;`)
	waitNativeDropCondition(t, win, `window.__terminalPainted`)
	waitNativeDropCondition(t, win, `(() => {const root=document.querySelector('.pui-terminal-viewport'),rows=document.querySelector('.xterm-rows'),cell=rows?.querySelector('span'),surface=document.querySelector('.xterm-scrollable-element'),viewport=document.querySelector('.xterm-viewport');return !!cell && cell.getBoundingClientRect().width>20 && getComputedStyle(rows).fontSize===getComputedStyle(root).fontSize && getComputedStyle(rows).color===getComputedStyle(root).color && [surface,viewport].every(node=>getComputedStyle(node).backgroundColor===getComputedStyle(root).backgroundColor);})()`)
	saveUsabilityScreenshot(t, win, "terminal-native.png")
	nativeDropEval(t, win, `[...document.querySelectorAll('.pui-tools button')].find(b=>b.textContent==='Close terminal').click();return true;`)
	waitNativeDropCondition(t, win, `[...document.querySelectorAll('.pui-tools button')].some(b=>!b.hidden && b.textContent==='Start terminal')`)
	if files, err := os.ReadDir(workspace.Path); err != nil || len(files) < 3 {
		t.Fatal("native fixture lost workspace files", err)
	}
}
