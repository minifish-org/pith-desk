package main

import (
	"context"
	"fmt"
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
// platform chrome and composer geometry that Chromium cannot reproduce.
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
	server.SetTitlebarOverlay(desktopWindowOptions().TitleBarStyle == mygo.TitleBarHiddenInset)
	var win *mygo.Window
	mygo.RunOnMain(func() {
		opts := desktopWindowOptions()
		opts.StateKey = ""
		opts.Title = "Pith Desk UI verification"
		win = mygo.NewWindow(opts)
	})
	defer win.Destroy()
	if err := win.Page().LoadURL(server.URL); err != nil {
		t.Fatal(err)
	}
	win.Show()
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
		t.Fatalf("native condition failed: %s; titlebar %v", code, eval(`({height:getComputedStyle(document.documentElement).getPropertyValue('--mygo-titlebar-height'),style:document.documentElement.getAttribute('style'),dpr:devicePixelRatio})`))
	}
	wait(`!!document.querySelector('.pui-composer-toolbar')`)
	if eval(`document.querySelector('.pui-titlebar-overlay, .pui-native-titlebar') === null`) != true {
		t.Fatal("Linux must not reserve application content for window controls")
	}
	nativeScale := float64(win.ContentBounds().Width) / eval(`innerWidth`).(float64)
	for _, width := range []int{640, 590, 480, 390} {
		if float64(width)*nativeScale < float64(desktopWindowOptions().MinWidth) {
			continue
		}
		win.SetSize(int(float64(width)*nativeScale), int(700*nativeScale))
		wait(fmt.Sprintf(`Math.abs(innerWidth - %d) <= 1`, width))
		_ = eval(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`)
		geometry := eval(`(() => {
			const rect = node => { const r = node.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; };
			const native = getComputedStyle(document.documentElement),composer = document.querySelector('.pui-composer');
			return {viewport:innerWidth,dpr:devicePixelRatio,font:getComputedStyle(composer).fontSize,
				header:rect(document.querySelector('.pui-topbar')),composer:rect(composer),
				permission:rect(document.querySelector('.pui-permission-control')),caption:rect(document.querySelector('.pui-permission-control .pui-select-value')),
				nativeHeight:native.getPropertyValue('--mygo-titlebar-height'),nativeRight:native.getPropertyValue('--mygo-titlebar-inset-right')};
		})()`)
		t.Logf("width %d: %v", width, geometry)
		if eval(`document.querySelector('.pui-composer').getBoundingClientRect().width <= 680 && document.querySelector('.pui-permission-control .pui-select-value').getBoundingClientRect().width > 1`) == true {
			t.Error("permission text must collapse before the composer actions wrap")
		}
		if eval(`(() => {const centers=[...document.querySelectorAll('.pui-composer-context > *, .pui-composer-actions > *')].filter(node=>node.getBoundingClientRect().width).map(node=>{const r=node.getBoundingClientRect();return r.y+r.height/2}); return Math.max(...centers)-Math.min(...centers)<=1;})()`) != true {
			t.Error("the composer controls do not share one centered row")
		}
	}
	for _, zoom := range []float64{1.25, .8, 1} {
		width := max(desktopWindowOptions().MinWidth, int(480*nativeScale*zoom))
		win.SetSize(width, int(700*nativeScale))
		win.Page().SetZoomFactor(zoom)
		wait(fmt.Sprintf(`Math.abs(innerWidth-%f)<=1`, float64(width)/nativeScale/zoom))
		if eval(`document.querySelector('.pui-titlebar-overlay, .pui-native-titlebar') === null`) != true {
			t.Errorf("page zoom %v must not add application window controls", zoom)
		}
	}
	if os.Getenv("PITH_DESK_NATIVE_INSPECT") == "1" && !t.Failed() {
		closed := make(chan struct{})
		win.OnClosed(func() { close(closed) })
		t.Log("Ready for native visual inspection; close the verification window to finish")
		select {
		case <-closed:
		case <-time.After(2 * time.Minute):
			t.Error("native visual inspection timed out")
		}
	}
}
