package main

import (
	"fmt"
	"os"
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

func TestApprovalDockNativeBadgeRoundTrip(t *testing.T) {
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
	var status *approvalDock
	mygo.RunOnMain(func() {
		status = installDockApprovalStatus(server)
		// Observe the real installation's quit hook after it has cleared the
		// native tile, while the native event loop is still running.
		mygo.App.OnWillQuit(func(_ *mygo.QuitEvent) {
			nativeQuitBadge <- mygo.App.Dock.Badge()
		})
	})
	nativeBeforeQuit = func() error {
		status.setPending(true)
		return awaitNativeBadge("!")
	}
	status.setPending(false)
	waitNativeBadge(t, "")
	status.setPending(true)
	waitNativeBadge(t, "!")
	status.setPending(false)
	waitNativeBadge(t, "")
	status.setPending(true)
	waitNativeBadge(t, "!")
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
