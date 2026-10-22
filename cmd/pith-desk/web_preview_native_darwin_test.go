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
	if _, err = service.CreateConversation(workspace.ID); err != nil {
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
		opts.Title = "Pith Desk web preview smoke"
		opts.StateKey = ""
		opts.Hidden = true
		win = newNativeTestWindow(t, opts)
		win.installBrowser(server)
	})
	defer win.Destroy()
	if err = win.Page().LoadURL(server.URL); err != nil {
		t.Fatal(err)
	}
	win.Show()
	win.Focus()
	waitNativeDropCondition(t, win, `!!document.querySelector('textarea[aria-label="Message Pith"]') && !document.querySelector('textarea[aria-label="Message Pith"]').readOnly`)
	nativeDropEval(t, win, `document.querySelector('button[aria-label="Toggle tools"]').click();document.querySelector('button[aria-label="New tool tab"]').click();return true;`)
	waitNativeDropCondition(t, win, `[...document.querySelectorAll('[role="menuitem"]')].some(b=>b.textContent==='New Web')`)
	nativeDropEval(t, win, `[...document.querySelectorAll('[role="menuitem"]')].find(b=>b.textContent==='New Web').click();return true;`)
	waitNativeDropCondition(t, win, `!!document.querySelector('input[aria-label="Web address"]') && !document.querySelector('input[aria-label="Web address"]').disabled`)
	nativeDropEval(t, win, `const input=document.querySelector('input[aria-label="Web address"]');input.value=`+strconv.Quote(projectURL)+`;input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;`)
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
		deadline := time.Now().Add(5 * time.Second)
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
			if visible == shown && v != nil && b.Height > 100 && matches {
				return v
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatal("native browser visibility/bounds did not settle")
		return nil
	}
	browser := waitBrowser(true)
	nativeDropEval(t, win, `document.querySelector('button[aria-label="Close tools"]').click();return true;`)
	waitBrowser(false)
	if browser.IsDestroyed() {
		t.Fatal("hidden browser was destroyed")
	}
	nativeDropEval(t, win, `document.querySelector('button[aria-label="Toggle tools"]').click();return true;`)
	if waitBrowser(true) != browser {
		t.Fatal("tab switching replaced browser")
	}
	// Modal focus must stay in the existing Pith UI dialog.
	nativeDropEval(t, win, `[...document.querySelectorAll('button')].find(b=>b.textContent==='Settings').click();return true;`)
	waitNativeDropCondition(t, win, `!!document.querySelector('dialog[open]')`)
	waitBrowser(false)
	nativeDropEval(t, win, `document.querySelector('dialog[open]').close();return true;`)
	waitBrowser(true)
	// A second native page must retain the first page and its live state.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
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
	nativeDropEval(t, win, `document.querySelector('button[aria-label="New tool tab"]').click();return true;`)
	waitNativeDropCondition(t, win, `!!document.querySelector('[role="menu"]:popover-open')`)
	nativeDropEval(t, win, `[...document.querySelectorAll('[role="menuitem"]')].find(b=>b.textContent==='New Web').click();return true;`)
	nativeDropEval(t, win, `const input=document.querySelector('.pui-tool-panel:not([hidden]) input[aria-label="Web address"]');input.value=`+strconv.Quote(projectURL+"/second")+`;input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;`)
	second := waitBrowser(true, browser)
	if second == browser || browser.IsDestroyed() {
		t.Fatal("second native tab replaced the first page")
	}
	nativeDropEval(t, win, `[...document.querySelectorAll('.pui-tools [role="tab"]')].filter(b=>b.textContent==='Web')[0].click();return true;`)
	if waitBrowser(true, second) != browser {
		t.Fatal("switching native tabs did not restore the original page")
	}
	if value, err := browser.Page().EvalContext(ctx, `window.retainedNativeState`); err != nil || value != "kept" {
		t.Fatalf("native page state was lost: %v %v", value, err)
	}
	nativeDropEval(t, win, `document.querySelector('.pui-tool-panel:not([hidden])').closest('.pui-workspace-tools').querySelector('button[aria-label="Close Web"]').click();return true;`)

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
}
