package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/egoist/mygo"
	"github.com/minifish-org/pith-desk/internal/desk"
)

type nativePreviewProbe struct{}

func (*nativePreviewProbe) Probe() bool { return true }
func init() {
	if os.Getenv("PITH_DESK_NATIVE_SMOKE") == "1" {
		mygo.BindAs("previewSecurity", &nativePreviewProbe{})
	}
}

func TestWebPreviewNativeIsolationAndSocket(t *testing.T) {
	if os.Getenv("PITH_DESK_NATIVE_SMOKE") != "1" {
		t.Skip("set PITH_DESK_NATIVE_SMOKE=1 for native web preview acceptance")
	}
	ready, socketReady := make(chan bool, 1), make(chan bool, 1)
	listener, err := net.Listen("tcp6", "[::1]:0")
	if err != nil {
		t.Skipf("IPv6 loopback unavailable: %v", err)
	}
	project := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" {
			t.Error("Desk credentials reached project")
		}
		switch r.URL.Path {
		case "/ready":
			ready <- r.URL.Query().Get("isolated") == "yes"
		case "/socket-ready":
			socketReady <- true
		case "/hmr":
			conn, err := websocket.Accept(w, r, nil)
			if err != nil {
				return
			}
			defer conn.CloseNow()
			kind, data, err := conn.Read(r.Context())
			if err == nil {
				_ = conn.Write(r.Context(), kind, data)
			}
		default:
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprint(w, `<!doctype html><h1>Native project</h1><script>const isolated=opener===null&&parent===window?'yes':'no';fetch('/ready?isolated='+isolated);const url=new URL('/hmr',location.href);url.protocol='ws:';const ws=new WebSocket(url);ws.onopen=()=>ws.send('ready');ws.onmessage=()=>fetch('/socket-ready');</script>`)
		}
	}))
	project.Listener.Close()
	project.Listener = listener
	project.Start()
	_, projectPort, _ := net.SplitHostPort(listener.Addr().String())
	projectURL := "http://localhost:" + projectPort
	defer project.Close()
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
	server, err := startNativeSmokeHost(service)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	var win *desktopWindow
	mygo.RunOnMain(func() {
		win = newNativeTestWindow(t, server)
		win.installBrowser(server)
	})
	defer win.Destroy()
	if err = win.Page().LoadURL(server.URL); err != nil {
		t.Fatal(err)
	}
	win.Show()
	win.Focus()
	waitNativeDropCondition(t, win, `!!document.querySelector('textarea[aria-label="Message Pith"]') && !document.querySelector('textarea[aria-label="Message Pith"]').readOnly && !!document.querySelector('button[aria-label="Toggle tools"]')`)
	clickControl := func(selector string) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for {
			if nativeDropEval(t, win, `(() => {const button=document.querySelector(`+strconv.Quote(selector)+`);if(!button)return false;for(const type of ['pointerdown','pointerup'])button.dispatchEvent(new PointerEvent(type,{bubbles:true,button:0,pointerId:1}));button.click();return true})()`) == true {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("native control did not appear: %s", selector)
			}
			time.Sleep(15 * time.Millisecond)
		}
	}
	clickControl(`button[aria-label="Toggle tools"]`)
	openNativeFilesTab(t, win)
	clickControl(`button[aria-label="New tool tab"]`)
	waitNativeDropCondition(t, win, `[...document.querySelectorAll('[role="menuitem"]')].some(b=>b.textContent==='New Web')`)
	nativeDropEval(t, win, `[...document.querySelectorAll('[role="menuitem"]')].find(b=>b.textContent==='New Web').click();return true;`)
	waitNativeDropCondition(t, win, `!!document.querySelector('input[aria-label="Web address"]') && !document.querySelector('input[aria-label="Web address"]').disabled`)
	nativeDropEval(t, win, `const input=document.querySelector('input[aria-label="Web address"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,`+strconv.Quote(projectURL)+`);input.dispatchEvent(new Event('input',{bubbles:true}));return true;`)
	waitNativeDropCondition(t, win, `document.querySelector('input[aria-label="Web address"]').value === `+strconv.Quote(projectURL))
	nativeDropEval(t, win, `document.querySelector('input[aria-label="Web address"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;`)
	select {
	case isolated := <-ready:
		if !isolated {
			t.Fatal("project read Desk document")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("native browser did not load project")
	}
	select {
	case <-socketReady:
	case <-time.After(10 * time.Second):
		t.Fatal("native project WebSocket did not connect")
	}

	waitNativeDropCondition(t, win, `!document.querySelector('iframe')`)
	waitBrowser := func(shown bool, excluded ...*mygo.WebView) *mygo.WebView {
		t.Helper()
		deadline := time.Now().Add(15 * time.Second)
		for time.Now().Before(deadline) {
			win.mu.Lock()
			visible := win.shown != ""
			var v *mygo.WebView
			for _, page := range win.tabs {
				v = page
			}
			if visible {
				v = win.tabs[win.shown]
			}
			b := win.bounds
			win.mu.Unlock()
			matches := true
			for _, old := range excluded {
				if v == old {
					matches = false
				}
			}
			if visible == shown && v != nil && (!shown || b.Height > 100) && matches {
				return v
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Logf("preview state: %v", nativeDropEval(t, win, `JSON.stringify({panel:document.querySelector('[role="tabpanel"]:not(.hidden)')?.getBoundingClientRect(),modals:document.querySelectorAll('[role="dialog"]').length,address:document.querySelector('input[aria-label="Web address"]')?.value})`))
		win.mu.Lock()
		t.Logf("window: shown=%q bounds=%+v tabs=%d", win.shown, win.bounds, len(win.tabs))
		win.mu.Unlock()
		t.Fatal("native browser visibility/bounds did not settle")
		return nil
	}
	clickUntil := func(script, condition string) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for {
			nativeDropEval(t, win, script)
			if nativeDropEval(t, win, condition) == true {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("native control did not settle: %s", condition)
			}
			time.Sleep(30 * time.Millisecond)
		}
	}
	browser := waitBrowser(true)
	clickUntil(`[...document.querySelectorAll('[data-tools-rail] [role="tab"]')].find(tab=>tab.textContent.trim()==='Files')?.click();return true;`, `[...document.querySelectorAll('[data-tools-rail] [role="tab"]')].some(tab=>tab.textContent.trim()==='Files' && tab.getAttribute('aria-selected')==='true')`)
	waitBrowser(false)
	clickUntil(`document.querySelector('button[aria-label="Close tools"]')?.click();return true;`, `!document.querySelector('[data-tools-rail]') || document.querySelector('[data-tools-rail]').getBoundingClientRect().width < 50`)
	if browser.IsDestroyed() {
		t.Fatal("hidden browser was destroyed")
	}
	clickUntil(`document.querySelector('button[aria-label="Toggle tools"]')?.click();return true;`, `document.querySelector('[data-tools-rail]')?.getBoundingClientRect().width > 200`)
	clickUntil(`[...document.querySelectorAll('[data-tools-rail] [role="tab"]')].find(tab=>tab.textContent.trim()==='Web')?.click();return true;`, `[...document.querySelectorAll('[data-tools-rail] [role="tab"]')].some(tab=>tab.textContent.trim()==='Web' && tab.getAttribute('aria-selected')==='true')`)
	if waitBrowser(true) != browser {
		t.Fatal("tab switching replaced browser")
	}
	// Modal focus must stay in the existing application dialog.
	clickUntil(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Settings')?.click();return true;`, `!!document.querySelector('[role="dialog"]')`)
	waitBrowser(false)
	clickUntil(`document.querySelector('[data-slot="dialog-close"]')?.click();return true;`, `!document.querySelector('[role="dialog"]')`)
	waitBrowser(true)
	// A second native page must retain the first page and its live state.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	// A real Go binding must remain unreachable from localhost preview content,
	// including a plain go run/go test development build.
	denied, err := browser.Page().EvalContext(ctx, `mygo.call('previewSecurity.Probe').then(()=> 'allowed',error=>String(error))`)
	if err != nil || !strings.Contains(fmt.Sprint(denied), "not allowed to call Go") {
		t.Fatalf("localhost preview got native IPC authority: %v %v", denied, err)
	}

	if _, err := browser.Page().EvalContext(ctx, `window.retainedNativeState='kept'`); err != nil {
		t.Fatal(err)
	}
	// Workspace views and narrow drawers may unmount. They must keep the same
	// native page, including state that is deliberately absent from preferences.
	other, err := service.AddWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.CreateConversation(other.ID); err != nil {
		t.Fatal(err)
	}
	waitNativeDropCondition(t, win, `!document.querySelector('input[aria-label="Web address"]')`)
	waitBrowser(false)
	if browser.IsDestroyed() {
		t.Fatal("switching workspace destroyed the native page")
	}
	if err := service.OpenConversation(conversation.ID); err != nil {
		t.Fatal(err)
	}
	waitNativeDropCondition(t, win, `document.querySelector('input[aria-label="Web address"]')?.value === `+strconv.Quote(projectURL))
	if waitBrowser(true) != browser {
		t.Fatal("returning to workspace replaced the native page")
	}
	win.SetSize(600, 760)
	waitNativeDropCondition(t, win, `innerWidth < 900 && !!document.querySelector('button[aria-label="Toggle tools"]')`)
	clickUntil(`document.querySelector('button[aria-label="Toggle tools"]')?.click();return true;`, `!!document.querySelector('[data-drawer-panel] input[aria-label="Web address"]')`)
	if waitBrowser(true) != browser {
		t.Fatal("narrow drawer replaced the native page")
	}
	clickUntil(`document.querySelector('button[aria-label="Close tools"]')?.click();return true;`, `!document.querySelector('[data-drawer-panel]')`)
	waitBrowser(false)
	clickUntil(`document.querySelector('button[aria-label="Toggle tools"]')?.click();return true;`, `!!document.querySelector('[data-drawer-panel] input[aria-label="Web address"]')`)
	if waitBrowser(true) != browser {
		t.Fatal("reopening the narrow drawer replaced the native page")
	}
	win.SetSize(1320, 860)
	waitNativeDropCondition(t, win, `innerWidth >= 900 && !document.querySelector('[data-drawer-panel]')`)
	if waitBrowser(true) != browser {
		t.Fatal("restoring wide layout replaced the native page")
	}
	if value, err := browser.Page().EvalContext(ctx, `window.retainedNativeState`); err != nil || value != "kept" {
		t.Fatalf("workspace/drawer navigation lost native page state: %v %v", value, err)
	}
	nativeDropEval(t, win, `const b=document.querySelector('button[aria-label="New tool tab"]');for(const type of ['pointerdown','pointerup'])b.dispatchEvent(new PointerEvent(type,{bubbles:true,button:0,pointerId:1}));return true;`)
	waitNativeDropCondition(t, win, `[...document.querySelectorAll('[role="menuitem"]')].some(b=>b.textContent==='New Web')`)
	nativeDropEval(t, win, `[...document.querySelectorAll('[role="menuitem"]')].find(b=>b.textContent==='New Web').click();return true;`)
	nativeDropEval(t, win, `const input=document.querySelector('[role="tabpanel"]:not(.hidden) input[aria-label="Web address"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,`+strconv.Quote(projectURL+"/second")+`);input.dispatchEvent(new Event('input',{bubbles:true}));return true;`)
	waitNativeDropCondition(t, win, `document.querySelector('[role="tabpanel"]:not(.hidden) input[aria-label="Web address"]').value === `+strconv.Quote(projectURL+"/second"))
	nativeDropEval(t, win, `document.querySelector('[role="tabpanel"]:not(.hidden) input[aria-label="Web address"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;`)
	second := waitBrowser(true, browser)
	if second == browser || browser.IsDestroyed() {
		t.Fatal("second native tab replaced the first page")
	}
	nativeDropEval(t, win, `[...document.querySelectorAll('[data-tools-rail] [role="tab"]')].filter(b=>b.textContent==='Web')[0].click();return true;`)
	if waitBrowser(true, second) != browser {
		t.Fatal("switching native tabs did not restore the original page")
	}
	if value, err := browser.Page().EvalContext(ctx, `window.retainedNativeState`); err != nil || value != "kept" {
		t.Fatalf("native page state was lost: %v %v", value, err)
	}
	nativeDropEval(t, win, `document.querySelector('[role="tabpanel"]:not(.hidden)').closest('[data-tools-rail]').querySelector('button[aria-label="Close Web"]').click();return true;`)

	deadline := time.Now().Add(5 * time.Second)
	for !browser.IsDestroyed() && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if !browser.IsDestroyed() {
		t.Fatal("closing native browser did not destroy it")
	}
	if second.IsDestroyed() {
		t.Fatal("closing one native tab destroyed another")
	}
	if err := service.RemoveWorkspace(workspace.ID, 1); err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(5 * time.Second)
	for !second.IsDestroyed() && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if !second.IsDestroyed() {
		t.Fatal("removing the workspace left its native page alive")
	}
}
