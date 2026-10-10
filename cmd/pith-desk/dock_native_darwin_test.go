package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo"
	"github.com/minifish-org/pith-desk/internal/desk"
	"github.com/minifish-org/pith-desk/internal/host"
)

var nativeQuitBadge = make(chan string, 1)
var nativeBeforeQuit func() error

// Native smoke checks are opt-in and need an interactive macOS session. They
// use disposable WebView/window data, never the application's normal data.
func TestMain(m *testing.M) {
	if os.Getenv("PITH_DESK_NATIVE_SMOKE") != "1" {
		os.Exit(m.Run())
	}
	dataDir, err := os.MkdirTemp("", "pith-desk-native-smoke-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	mygo.App.SetPath(mygo.PathUserData, dataDir)
	result := make(chan int, 1)
	code := 1
	mygo.App.WhenReady(func() {
		mygo.NewWindow(mygo.WindowOptions{Title: "Pith Desk native smoke", Hidden: true, Width: 300, Height: 200})
		go func() {
			code := m.Run()
			// m.Run has finished every test cleanup. Re-arm the real badge here
			// so an earlier host Close cannot masquerade as quit-hook cleanup.
			if nativeBeforeQuit != nil {
				if err := nativeBeforeQuit(); err != nil {
					fmt.Fprintln(os.Stderr, err)
					code = 1
				} else {
					fmt.Printf("native Dock badge before quit = %q\n", mygo.App.Dock.Badge())
				}
			}
			result <- code
			mygo.App.Quit()
		}()
	})
	if err := mygo.App.Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		code = 1
	} else {
		code = <-result
		select {
		case badge := <-nativeQuitBadge:
			fmt.Printf("native Dock badge on quit = %q\n", badge)
			if badge != "" {
				code = 1
			}
		default:
			if nativeBeforeQuit != nil {
				fmt.Fprintln(os.Stderr, "native Dock quit callback did not report a badge")
				code = 1
			}
		}
	}
	_ = os.RemoveAll(dataDir)
	os.Exit(code)
}

func TestTaskDockNativeBadgeRoundTrip(t *testing.T) {
	if os.Getenv("PITH_DESK_NATIVE_SMOKE") != "1" {
		t.Skip("set PITH_DESK_NATIVE_SMOKE=1 for native macOS Dock verification")
	}
	service, err := desk.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(service.Close)
	server, err := host.Start(service, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	var status *taskDock
	mygo.RunOnMain(func() {
		status = installDockTaskStatus(server)
		// Observe the real installation's quit hook after it has cleared the
		// native tile, while the native event loop is still running.
		mygo.App.OnWillQuit(func(_ *mygo.QuitEvent) {
			nativeQuitBadge <- mygo.App.Dock.Badge()
		})
	})
	nativeBeforeQuit = func() error {
		status.setStatus(host.TaskStatus{NeedsApproval: true})
		return awaitNativeBadge("!")
	}
	status.setStatus(host.TaskStatus{})
	waitNativeBadge(t, "")
	status.setStatus(host.TaskStatus{Running: 1})
	waitNativeBadge(t, "…")
	status.setStatus(host.TaskStatus{Unread: 1})
	waitNativeBadge(t, "1")
	status.setStatus(host.TaskStatus{Unread: 2, Running: 1})
	waitNativeBadge(t, "2")
	status.setStatus(host.TaskStatus{Unread: 2, NeedsApproval: true, Running: 1})
	waitNativeBadge(t, "!")
	status.setStatus(host.TaskStatus{Unread: 2, Running: 1})
	waitNativeBadge(t, "2")
	status.setStatus(host.TaskStatus{})
	waitNativeBadge(t, "")
	status.setStatus(host.TaskStatus{NeedsApproval: true})
	waitNativeBadge(t, "!")
}

// Exercise the production host and embedded UI as well as the native badge.
// A hidden WebView must retain unread completion; focusing it acknowledges the
// actual result through the authenticated API and clears the same Dock count.
func TestTaskDockNativeUnreadLifecycle(t *testing.T) {
	if os.Getenv("PITH_DESK_NATIVE_SMOKE") != "1" {
		t.Skip("set PITH_DESK_NATIVE_SMOKE=1 for native macOS unread verification")
	}
	releaseRequest := make(chan struct{})
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(releaseRequest) }) }
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		<-releaseRequest
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Done\"}}]}\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
		w.(http.Flusher).Flush()
	}))
	defer provider.Close()
	defer release()
	service, err := desk.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(service.Close)
	workspace, err := service.AddWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	conversation, err := service.CreateConversation(workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.Configure(desk.ConfigInput{BaseURL: provider.URL + "/v1", Model: "deepseek-flash", APIKey: "fixture-key"}); err != nil {
		t.Fatal(err)
	}
	server, err := host.Start(service, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	var win *mygo.Window
	mygo.RunOnMain(func() {
		installDockTaskStatus(server)
		win = mygo.NewWindow(mygo.WindowOptions{Title: "Pith Desk Dock smoke", Hidden: true, Width: 1320, Height: 860})
	})
	t.Cleanup(win.Destroy)
	if err := win.Page().LoadURL(server.URL); err != nil {
		t.Fatal(err)
	}
	waitNativeDropCondition(t, win, `document.querySelector('#composer-input')?.placeholder !== undefined && document.querySelector('#composer-input')?.placeholder !== 'Connecting to Pith…'`)
	if err := service.SendConversation(conversation.ID, "Finish the isolated Dock fixture"); err != nil {
		t.Fatal(err)
	}
	waitNativeBadge(t, "…")
	release()
	waitNativeBadge(t, "1")
	waitNativeDropCondition(t, win, `document.querySelector('.history-unread') !== null && !document.hasFocus()`)
	if !service.Snapshot().Conversations[0].Unread {
		t.Fatal("background WebView acknowledged a result it was not displaying")
	}
	mygo.RunOnMain(func() {
		win.Show()
		win.Focus()
	})
	waitNativeDropCondition(t, win, `document.hasFocus() && document.querySelector('.history-unread') === null`)
	waitNativeBadge(t, "")
	if service.Snapshot().Conversations[0].Unread {
		t.Fatal("viewing the completed conversation did not acknowledge its result")
	}
	t.Log("hidden embedded UI retained the unread Dock badge; focusing the conversation cleared it through the authenticated read route")
}

func waitNativeBadge(t *testing.T, expected string) {
	t.Helper()
	if err := awaitNativeBadge(expected); err != nil {
		t.Fatal(err)
	}
	t.Logf("native Dock badge = %q", mygo.App.Dock.Badge())
}

func awaitNativeBadge(expected string) error {
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		actual := mygo.App.Dock.Badge()
		if actual == expected {
			return nil
		}
		time.Sleep(10 * time.Millisecond)
	}
	return fmt.Errorf("native Dock badge = %q, want %q", mygo.App.Dock.Badge(), expected)
}
