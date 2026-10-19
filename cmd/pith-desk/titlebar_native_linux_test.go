package main

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/egoist/mygo"
	"github.com/minifish-org/pith-desk/internal/desk"
	"github.com/minifish-org/pith-desk/internal/host"
)

func TestMain(m *testing.M) {
	if os.Getenv("PITH_DESK_NATIVE_SMOKE") != "1" {
		os.Exit(m.Run())
	}
	data, err := os.MkdirTemp("", "pith-desk-native-smoke-")
	if err != nil {
		panic(err)
	}
	mygo.App.SetPath(mygo.PathUserData, data)
	result := make(chan int, 1)
	mygo.App.WhenReady(func() {
		mygo.NewWindow(mygo.WindowOptions{Hidden: true})
		go func() { result <- m.Run(); mygo.App.Quit() }()
	})
	if err := mygo.App.Run(); err != nil {
		panic(err)
	}
	code := <-result
	_ = os.RemoveAll(data)
	os.Exit(code)
}

// Use the production window options and the real WebKitGTK host. This catches
// native titlebar geometry that Chromium and macOS WebKit cannot reproduce.
func TestTitlebarNativeLinuxAndNarrowComposer(t *testing.T) {
	if os.Getenv("PITH_DESK_NATIVE_SMOKE") != "1" {
		t.Skip("set PITH_DESK_NATIVE_SMOKE=1 in an interactive Linux desktop")
	}
	service, err := desk.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	workspace, err := service.AddWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.CreateConversation(workspace.ID); err != nil {
		t.Fatal(err)
	}
	server, err := host.Start(service, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	server.SetTitlebarOverlay(true)
	var win *mygo.Window
	mygo.RunOnMain(func() { opts := desktopWindowOptions(); opts.StateKey = ""; win = mygo.NewWindow(opts) })
	defer win.Destroy()
	if err := win.Page().LoadURL(server.URL); err != nil {
		t.Fatal(err)
	}
	eval := func(code string) any {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		value, err := win.Page().EvalContext(ctx, code)
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	wait := func(code string) {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			if eval(code) == true {
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatalf("native condition failed: %s", code)
	}
	wait(`!!document.querySelector('.pui-composer-toolbar')`)
	for _, width := range []int{960, 720, 590, 480} {
		mygo.RunOnMain(func() { win.SetSize(width, 700); win.Show() })
		_ = eval(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`)
		t.Logf("native bounds: %v, zoom: %v", win.Bounds(), win.Page().ZoomFactor())
		geometry := eval(`(() => {
			const rect = node => { const r = node.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; };
			const native = getComputedStyle(document.documentElement),composer = document.querySelector('.pui-composer');
			return {viewport:innerWidth,dpr:devicePixelRatio,font:getComputedStyle(composer).fontSize,container:getComputedStyle(composer).containerType,supports:CSS.supports('container-type','inline-size'),
				header:rect(document.querySelector('.pui-topbar')),composer:rect(composer),
				permission:rect(document.querySelector('.pui-permission-control')),caption:rect(document.querySelector('.pui-permission-control .pui-select-value')),
				nativeHeight:native.getPropertyValue('--mygo-titlebar-height'),nativeRight:native.getPropertyValue('--mygo-titlebar-inset-right')};
		})()`)
		t.Logf("width %d: %v", width, geometry)
		if eval(`document.querySelector('.pui-composer').getBoundingClientRect().width <= 680 && document.querySelector('.pui-permission-control .pui-select-value').getBoundingClientRect().width > 1`) == true {
			t.Error("permission text must collapse before the composer actions wrap")
		}
		if eval(`parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mygo-titlebar-height')) >= 52`) != true {
			t.Error("native title controls do not occupy the integrated navigation row")
		}
	}
}
