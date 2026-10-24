package main

import (
	"flag"
	"testing"

	"github.com/egoist/mygo"

	"github.com/minifish-org/pith-desk/internal/desk"
	"github.com/minifish-org/pith-desk/internal/host"
)

// Explicit source preview is opt-in, like the development runner. Default
// native smoke tests always exercise the application's embedded frontend.
var nativeUIURL = flag.String("native-ui-url", "", "explicit loopback development UI for native acceptance")
var nativeUIRoot = flag.String("native-ui-root", "", "explicit frontend checkout for native acceptance")

func startNativeSmokeHost(service *desk.Service) (*host.Server, error) {
	if *nativeUIURL != "" {
		return host.StartDevelopment(service, nil, host.DevelopmentOptions{URL: *nativeUIURL, UIRoot: *nativeUIRoot})
	}
	return host.Start(service, nil)
}

func newNativeTestWindow(t *testing.T, server *host.Server) *desktopWindow {
	t.Helper()
	// Exercise the product frame without restoring or persisting window state.
	opts := desktopWindowOptions()
	opts.StateKey = ""
	server.SetTitlebarOverlay(opts.TitleBarStyle == mygo.TitleBarHiddenInset)
	win, err := newDesktopWindow(opts)
	if err != nil {
		t.Fatal(err)
	}
	return win
}
