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
	var win *desktopWindow
	mygo.RunOnMain(func() {
		opts := desktopWindowOptions()
		opts.Title = "Pith Desk terminal smoke"
		opts.StateKey = ""
		opts.Hidden = true
		win = newNativeTestWindow(t, opts)
	})
	defer win.Destroy()
	if err = win.Page().LoadURL(server.URL); err != nil {
		t.Fatal(err)
	}
	win.Show()
	win.Focus()
	show := func() {
		waitNativeDropCondition(t, win, `!!document.querySelector('textarea[aria-label="Message Pith"]') && !document.querySelector('textarea[aria-label="Message Pith"]').readOnly`)
		nativeDropEval(t, win, `const rail=document.querySelector('[data-tools-rail]');if(!rail||rail.getBoundingClientRect().width<200)document.querySelector('button[aria-label="Toggle tools"]')?.click();return true;`)
		waitNativeDropCondition(t, win, `[...document.querySelectorAll('[data-tools-rail] [role="tab"]')].some(b=>b.textContent==='Terminal')`)
		nativeDropEval(t, win, `[...document.querySelectorAll('[data-tools-rail] [role="tab"]')].find(b=>b.textContent==='Terminal').click();return true;`)
	}
	waitNativeDropCondition(t, win, `!!document.querySelector('textarea[aria-label="Message Pith"]') && !document.querySelector('textarea[aria-label="Message Pith"]').readOnly`)
	openTools := func() {
		deadline := time.Now().Add(5 * time.Second)
		for {
			if nativeDropEval(t, win, `(() => {const b=document.querySelector('button[aria-label="Toggle tools"]');if(!b)return false;b.click();return true})()`) == true {
				return
			}
			if time.Now().After(deadline) {
				t.Fatal("native tools toggle did not appear")
			}
			time.Sleep(15 * time.Millisecond)
		}
	}
	openTools()
	newTerminal := func() {
		deadline := time.Now().Add(5 * time.Second)
		for {
			if nativeDropEval(t, win, `(() => {const b=document.querySelector('button[aria-label="New tool tab"]');if(!b)return false;for(const type of ['pointerdown','pointerup'])b.dispatchEvent(new PointerEvent(type,{bubbles:true,button:0,pointerId:1}));return true})()`) == true {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("native new-tool control did not appear")
			}
			time.Sleep(15 * time.Millisecond)
		}
		waitNativeDropCondition(t, win, `[...document.querySelectorAll('[role="menuitem"]')].some(b=>b.textContent==='New terminal')`)
		nativeDropEval(t, win, `[...document.querySelectorAll('[role="menuitem"]')].find(b=>b.textContent==='New terminal').click();return true;`)
	}
	newTerminal()
	enter := func(text string) {
		waitNativeDropCondition(t, win, `!!document.querySelector('[role="tabpanel"]:not(.hidden) textarea[aria-label="Terminal input"]') && !!document.querySelector('[role="tabpanel"]:not(.hidden) [aria-label="Interactive terminal"][aria-disabled="false"]')`)
		nativeDropEval(t, win, `const input=document.querySelector('[role="tabpanel"]:not(.hidden) textarea[aria-label="Terminal input"]');input.focus();const data=new DataTransfer();data.setData('text/plain',`+strconv.Quote(text)+`);input.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));return true;`)
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
	waitNativeDropCondition(t, win, `document.querySelector('[data-terminal-viewport]').textContent.includes('Native 中文')`)
	nativeDropEval(t, win, `[...document.querySelectorAll('[data-tools-rail] [role="tab"]')].find(b=>b.textContent==='Files').click();document.querySelector('button[aria-label="Refresh workspace files"]').click();return true;`)
	waitNativeDropCondition(t, win, `[...document.querySelectorAll('[data-tools-rail] button')].some(b=>b.textContent.trim()==='native-ready')`)
	nativeDropEval(t, win, `window.__terminalOldDocument=true;return true;`)
	if err = win.Page().LoadURL(server.URL); err != nil {
		t.Fatal(err)
	}
	waitNativeDropCondition(t, win, `!window.__terminalOldDocument && !!document.querySelector('textarea[aria-label="Message Pith"]')`)
	show()
	waitNativeDropCondition(t, win, `document.querySelector('[data-terminal-viewport]').textContent.includes('Native 中文')`)
	enter(`echo $$ > after-refresh.pid; sleep 60`)
	waitNativeDropCondition(t, win, `!!document.querySelector('[role="tabpanel"]:not(.hidden) [aria-label="Interactive terminal"][aria-disabled="false"]')`)
	time.Sleep(100 * time.Millisecond)
	interrupted := false
	for deadline := time.Now().Add(10 * time.Second); !interrupted && time.Now().Before(deadline); {
		nativeDropEval(t, win, `document.querySelector('[data-tools-rail] button[aria-label="Interrupt terminal"]')?.click();return true;`)
		time.Sleep(250 * time.Millisecond)
		enter(`echo interrupted > native-interrupted`)
		for attempt := 0; attempt < 10; attempt++ {
			if data, _ := os.ReadFile(filepath.Join(workspace.Path, "native-interrupted")); string(data) == "interrupted\n" {
				interrupted = true
				break
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	if !interrupted {
		t.Fatal("native interrupt did not release foreground program")
	}
	first, _ := os.ReadFile(filepath.Join(workspace.Path, "first.pid"))
	second, _ := os.ReadFile(filepath.Join(workspace.Path, "after-refresh.pid"))
	if len(first) == 0 || string(first) != string(second) {
		t.Fatal("native refresh replaced shell")
	}
	enter(`export NATIVE_FIRST=only`)
	newTerminal()
	enter(`stty -echo; printf '%s' ${NATIVE_FIRST-unset} > native-second-state; printf 'Independent second terminal 中文\n'`)
	for deadline := time.Now().Add(5 * time.Second); ; {
		data, _ := os.ReadFile(filepath.Join(workspace.Path, "native-second-state"))
		if string(data) == "unset" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("native terminal tabs shared a process environment")
		}
		time.Sleep(20 * time.Millisecond)
	}
	nativeDropEval(t, win, `[...document.querySelectorAll('[data-tools-rail] [role="tab"]')].find(b=>b.textContent==='Terminal').click();return true;`)
	if value := nativeDropEval(t, win, `return document.querySelector('textarea[aria-label="Message Pith"]').value;`); value != "Native draft 中文" {
		t.Fatal("terminal changed native draft", value)
	}
	win.Show()
	win.Focus()
	waitNativeDropCondition(t, win, `document.visibilityState==='visible'`)
	nativeDropEval(t, win, `window.__terminalPainted=false;requestAnimationFrame(()=>requestAnimationFrame(()=>window.__terminalPainted=true));return true;`)
	waitNativeDropCondition(t, win, `window.__terminalPainted`)
	time.Sleep(300 * time.Millisecond)
	if nativeDropEval(t, win, `(() => {const root=document.querySelector('[data-terminal-viewport]'),rows=document.querySelector('.xterm-rows'),cell=rows?.querySelector('span'),surface=document.querySelector('.xterm-scrollable-element'),viewport=document.querySelector('.xterm-viewport');return !!cell && cell.getBoundingClientRect().width>20 && getComputedStyle(rows).fontSize===getComputedStyle(root).fontSize && getComputedStyle(rows).color===getComputedStyle(root).color && [surface,viewport].every(node=>getComputedStyle(node).backgroundColor===getComputedStyle(root).backgroundColor);})()`) != true {
		t.Fatal("native terminal viewport did not match the terminal surface")
	}
	saveUsabilityScreenshot(t, win, "terminal-native.png")
	nativeDropEval(t, win, `document.querySelector('button[aria-label="Close Terminal"]').click();return true;`)
	waitNativeDropCondition(t, win, `![...document.querySelectorAll('[data-tools-rail] [role="tab"]')].find(b=>b.textContent==='Terminal') && !![...document.querySelectorAll('[data-tools-rail] [role="tab"][aria-selected="true"]')].find(b=>b.textContent==='Terminal 2')`)
	enter(`printf 'still running\n'; echo alive > native-second-alive`)
	waitNativeDropCondition(t, win, `document.querySelector('[role="tabpanel"]:not(.hidden) [data-terminal-viewport]').textContent.includes('still running')`)
	nativeDropEval(t, win, `document.querySelector('button[aria-label="Close Terminal 2"]').click();return true;`)
	waitNativeDropCondition(t, win, `![...document.querySelectorAll('[data-tools-rail] [role="tab"]')].find(b=>b.textContent==='Terminal 2')`)
	if files, err := os.ReadDir(workspace.Path); err != nil || len(files) < 3 {
		t.Fatal("native fixture lost workspace files", err)
	}
}
