// Pith Desk hosts the embedded web interface in a native system webview.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"

	"github.com/egoist/mygo"
	"github.com/minifish-org/pith-desk/internal/desk"
	"github.com/minifish-org/pith-desk/internal/host"
)

func main() {
	if err := run(); err != nil {
		log.Printf("Pith Desk: %v", err)
		os.Exit(1)
	}
}

func run() error {
	// MyGo's packager executes the app to inspect bindings. No user data or
	// local listener should be created while generating that unused client.
	if os.Getenv("MYGO_GENERATE") != "" {
		return mygo.App.Run()
	}

	preview := flag.Bool("preview", false, "serve the interface for a browser without opening a desktop window")
	dataDir := flag.String("data-dir", "", "directory for settings and conversation history")
	flag.Parse()
	if flag.NArg() != 0 {
		return fmt.Errorf("unexpected arguments: %v", flag.Args())
	}
	if *dataDir == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			return fmt.Errorf("find application data directory: %w", err)
		}
		*dataDir = filepath.Join(base, "Pith Desk")
	}
	if *preview {
		return runPreview(*dataDir)
	}
	return runDesktop(*dataDir)
}

func runPreview(dataDir string) error {
	service, err := desk.New(dataDir)
	if err != nil {
		return err
	}
	defer service.Close()
	server, err := host.Start(service, nil)
	if err != nil {
		return err
	}
	defer server.Close()
	fmt.Printf("Pith Desk preview: %s\nKeep this terminal open. Press Ctrl+C to stop.\n", server.URL)
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	<-ctx.Done()
	return nil
}

func runDesktop(dataDir string) error {
	var service *desk.Service
	var server *host.Server
	var startupErr error
	var window atomic.Pointer[mygo.Window]
	var dialogMu sync.Mutex

	mygo.App.WhenReady(func() {
		service, startupErr = desk.New(dataDir)
		if startupErr != nil {
			mygo.App.Quit()
			return
		}
		pickDirectory := func() (string, error) {
			// Dialog.Open forwards native UI work to the main thread itself.
			// Calling this blocking method inside RunOnMain would be unnecessary.
			dialogMu.Lock()
			defer dialogMu.Unlock()
			paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
				Parent: window.Load(), Title: "Choose a workspace",
				Directory: true, CreateDirectories: true,
			})
			if err != nil || len(paths) == 0 {
				return "", err
			}
			return paths[0], nil
		}
		server, startupErr = host.Start(service, pickDirectory)
		if startupErr != nil {
			mygo.App.Quit()
			return
		}
		win := mygo.NewWindow(mygo.WindowOptions{
			Title: "Pith Desk", URL: server.URL,
			Width: 1320, Height: 860, MinWidth: 900, MinHeight: 600,
			TitleBarStyle:   mygo.TitleBarDefault,
			BackgroundColor: "#151719", StateKey: "main",
		})
		window.Store(win)
		appURL, _ := url.Parse(server.URL)
		win.Page().OnWillNavigate(func(e *mygo.NavigateEvent) {
			u, err := url.Parse(e.URL)
			if err == nil && u.Scheme == appURL.Scheme && u.Host == appURL.Host && (u.Path == "" || u.Path == "/") {
				return
			}
			e.PreventDefault()
			if e.UserInitiated && err == nil && externalWebURL(u, appURL) {
				go mygo.Shell.OpenExternal(u.String())
			}
		})
		win.Page().SetWindowOpenHandler(func(req mygo.WindowOpenRequest) *mygo.WindowOptions {
			if u, err := url.Parse(req.URL); err == nil && externalWebURL(u, appURL) {
				go mygo.Shell.OpenExternal(u.String())
			}
			return nil
		})
	})
	// Closing the last window quits the app by default. Cleanup also covers
	// Cmd+Q and termination signals, and releases pending Agent work.
	err := mygo.App.Run()
	if service != nil {
		service.Close()
	}
	if server != nil {
		err = errors.Join(err, server.Close())
	}
	return errors.Join(startupErr, err)
}

func externalWebURL(target, appURL *url.URL) bool {
	return (target.Scheme == "http" || target.Scheme == "https") && target.Host != "" && target.Host != appURL.Host && target.User == nil
}
