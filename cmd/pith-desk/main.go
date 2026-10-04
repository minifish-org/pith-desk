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
	// Keep native window state with the selected application data, including
	// isolated test instances started with --data-dir.
	dataDir, err := filepath.Abs(dataDir)
	if err != nil {
		return fmt.Errorf("resolve application data directory: %w", err)
	}
	mygo.App.SetPath(mygo.PathUserData, dataDir)
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
		// Native controls, the WebView's media query, and its initial background
		// use the same saved override as the frontend.
		mygo.Theme.SetSource(mygo.ThemeSource(service.Snapshot().Settings.Appearance))
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
		server, startupErr = host.Start(service, pickDirectory, func(mode desk.AppearanceMode) {
			mygo.Theme.SetSource(mygo.ThemeSource(mode))
		})
		if startupErr != nil {
			mygo.App.Quit()
			return
		}
		server.SetFileActions(mygo.Shell.OpenPath, func(path string) error {
			mygo.Shell.ShowItemInFolder(path)
			return nil
		})
		server.SetExportAction(func(markdown string) error {
			dialogMu.Lock()
			defer dialogMu.Unlock()
			downloads, err := mygo.App.Path(mygo.PathDownloads)
			if err != nil {
				return err
			}
			path, err := mygo.Dialog.Save(mygo.SaveDialogOptions{
				Parent: window.Load(), Title: "Export conversation",
				DefaultPath: filepath.Join(downloads, "conversation.md"), CreateDirectories: true,
				Filters: []mygo.FileFilter{{Name: "Markdown", Extensions: []string{"md"}}},
			})
			if err != nil || path == "" {
				return err // Cancel does not fall back to a browser download.
			}
			return os.WriteFile(path, []byte(markdown), 0o600)
		})
		server.SetDiagnosticsAction(func(data string) error {
			dialogMu.Lock()
			defer dialogMu.Unlock()
			path, err := mygo.Dialog.Save(mygo.SaveDialogOptions{
				Parent: window.Load(), Title: "Save diagnostics",
				DefaultPath: "pith-desk-diagnostics.json", CreateDirectories: true,
				Filters: []mygo.FileFilter{{Name: "JSON", Extensions: []string{"json"}}},
			})
			if err != nil || path == "" {
				return err
			}
			return os.WriteFile(path, []byte(data), 0o600)
		})
		win := mygo.NewWindow(mygo.WindowOptions{
			Title: "Pith Desk", Hidden: true,
			Width: 1320, Height: 860, MinWidth: 900, MinHeight: 600,
			TitleBarStyle:   mygo.TitleBarDefault,
			BackgroundColor: "light-dark(#F7F8FB, #17191C)", StateKey: "main",
		})
		window.Store(win)
		win.OnReadyToShow(win.Show)
		appURL, _ := url.Parse(server.URL)
		// Exports use the native save dialog. Download navigation bypasses MyGo's
		// navigation listener, so reject that separate path as well.
		win.Page().OnWillDownload(func(e *mygo.DownloadEvent) {
			e.PreventDefault()
		})
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
		win.Page().OnDidFailLoad(func(err *mygo.LoadError) {
			log.Printf("Pith Desk interface failed to load: %v", err)
			win.Show() // Leave reload and quit available after a failed load.
		})
		// Install the page policy before initiating its first navigation. The
		// constructor's URL option would start loading before these listeners.
		if err := win.Page().LoadURL(server.URL); err != nil {
			startupErr = fmt.Errorf("load desktop interface: %w", err)
			mygo.App.Quit()
		}
	})
	// Closing the last window quits the app by default. Cleanup also covers
	// Cmd+Q and termination signals, and releases pending Agent work.
	err = mygo.App.Run()
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
