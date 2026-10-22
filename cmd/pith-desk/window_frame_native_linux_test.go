package main

import (
	"os"
	"testing"

	"github.com/ebitengine/purego"
	"github.com/egoist/mygo"
)

func TestTitlebarNativeLinuxUsesSystemDecorations(t *testing.T) {
	if os.Getenv("PITH_DESK_NATIVE_SMOKE") != "1" {
		t.Skip("set PITH_DESK_NATIVE_SMOKE=1 in an interactive Linux desktop")
	}
	lib, err := purego.Dlopen("libgtk-3.so.0", purego.RTLD_LAZY|purego.RTLD_GLOBAL)
	if err != nil {
		t.Fatal(err)
	}
	defer purego.Dlclose(lib)
	var decorated func(uintptr) bool
	purego.RegisterLibFunc(&decorated, lib, "gtk_window_get_decorated")
	var win *desktopWindow
	mygo.RunOnMain(func() {
		opts := desktopWindowOptions()
		opts.StateKey = ""
		win = newNativeTestWindow(t, opts)
	})
	defer win.Destroy()
	var systemDecorated bool
	mygo.RunOnMain(func() { systemDecorated = decorated(win.NativeHandle()) })
	if !systemDecorated {
		t.Fatal("Linux window decorations must be owned by the desktop, without overlaid application controls")
	}
}
