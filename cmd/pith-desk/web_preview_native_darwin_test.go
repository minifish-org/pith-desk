package main

import (
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/egoist/mygo"
	"github.com/minifish-org/pith-desk/internal/desk"
)

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
			fmt.Fprint(w, `<!doctype html><h1>Native project</h1><script>let isolated='no';try{parent.document.body}catch{isolated='yes'}fetch('/ready?isolated='+isolated);const url=new URL('/hmr',location.href);url.protocol='ws:';const ws=new WebSocket(url);ws.onopen=()=>ws.send('ready');ws.onmessage=()=>fetch('/socket-ready');</script>`)
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
	var win *mygo.Window
	mygo.RunOnMain(func() {
		opts := desktopWindowOptions()
		opts.Title = "Pith Desk web preview smoke"
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
		t.Fatal("native iframe did not load project")
	}
	select {
	case <-socketReady:
	case <-time.After(10 * time.Second):
		t.Fatal("native project WebSocket did not connect")
	}
	waitNativeDropCondition(t, win, `(()=>{const frame=document.querySelector('iframe[title="Web preview"]');return !!frame && frame.getBoundingClientRect().height>100 && new URL(frame.src).origin!==location.origin})()`)
	nativeDropEval(t, win, `document.querySelector('button[aria-label="Close tools"]').click();return true;`)
	waitNativeDropCondition(t, win, `!document.querySelector('iframe')`)
}
