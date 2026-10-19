package main

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/ebitengine/purego"
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
	mygo.RunOnMain(func() {
		opts := desktopWindowOptions()
		opts.StateKey = ""
		opts.Title = "Pith Desk UI verification"
		prepareDesktopWindowControls(&opts)
		win = mygo.NewWindow(opts)
	})
	var cleanup func()
	mygo.RunOnMain(func() { cleanup = installDesktopWindowControls(win) })
	defer cleanup()
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
	wait(`parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mygo-titlebar-height')) === 52`)
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
		if eval(`parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mygo-titlebar-height')) >= 52`) != true {
			t.Error("native title controls do not occupy the integrated navigation row")
		}
		for _, button := range linuxTitleButtonBounds(t, win) {
			if float64(button.Width)/nativeScale < 40 || float64(button.Height)/nativeScale < 40 {
				t.Errorf("native title button has a small target: %+v at scale %v", button, nativeScale)
			}
			if center := (float64(button.Y) + float64(button.Height)/2) / nativeScale; center < 25 || center > 27 {
				t.Errorf("native title button is not centered in the navigation row: %+v at scale %v", button, nativeScale)
			}
		}
	}
	for _, zoom := range []float64{1.25, .8, 1} {
		width := max(desktopWindowOptions().MinWidth, int(480*nativeScale*zoom))
		win.SetSize(width, int(700*nativeScale))
		win.Page().SetZoomFactor(zoom)
		wait(fmt.Sprintf(`Math.abs(innerWidth-%f)<=1 && Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mygo-titlebar-height'))-52)<.75`, float64(width)/nativeScale/zoom))
		scale := float64(win.ContentBounds().Width) / eval(`innerWidth`).(float64)
		for _, button := range linuxTitleButtonBounds(t, win) {
			center := (float64(button.Y) + float64(button.Height)/2) / scale
			if float64(button.Width)/scale < 40 || float64(button.Height)/scale < 40 || center < 25 || center > 27 {
				t.Errorf("native title button did not follow page zoom %v: %+v at scale %v", zoom, button, scale)
			}
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

type gtkButtonBounds struct{ X, Y, Width, Height int32 }

// Inspect GTK's real targets without simulating pointer input or replacing
// the desktop's minimize/maximize/close actions.
func linuxTitleButtonBounds(t *testing.T, win *mygo.Window) []gtkButtonBounds {
	t.Helper()
	lib, err := purego.Dlopen("libgtk-3.so.0", purego.RTLD_LAZY|purego.RTLD_GLOBAL)
	if err != nil {
		t.Fatal(err)
	}
	defer purego.Dlclose(lib)
	var forall func(uintptr, uintptr, uintptr)
	var containerType func() uintptr
	var isType func(uintptr, uintptr) bool
	var hasClass func(uintptr, string) bool
	var visible func(uintptr) bool
	var getBounds func(uintptr, *gtkButtonBounds)
	var getPixelSize func(uintptr) int32
	var translate func(uintptr, uintptr, int32, int32, *int32, *int32) bool
	purego.RegisterLibFunc(&forall, lib, "gtk_container_forall")
	purego.RegisterLibFunc(&containerType, lib, "gtk_container_get_type")
	purego.RegisterLibFunc(&isType, lib, "g_type_check_instance_is_a")
	purego.RegisterLibFunc(&hasClass, lib, "gtk_style_context_has_class")
	purego.RegisterLibFunc(&visible, lib, "gtk_widget_get_visible")
	purego.RegisterLibFunc(&getBounds, lib, "gtk_widget_get_allocation")
	purego.RegisterLibFunc(&getPixelSize, lib, "gtk_image_get_pixel_size")
	purego.RegisterLibFunc(&translate, lib, "gtk_widget_translate_coordinates")
	api, _ := linuxControlsAPI()
	var buttons []gtkButtonBounds
	var icons []int32
	var callback uintptr
	callback = purego.NewCallback(func(widget, _ uintptr) {
		style := api.getStyle(widget)
		if visible(widget) && hasClass(style, "titlebutton") && (hasClass(style, "minimize") || hasClass(style, "maximize") || hasClass(style, "close")) {
			var r gtkButtonBounds
			getBounds(widget, &r)
			translate(widget, win.NativeHandle(), 0, 0, &r.X, &r.Y)
			buttons = append(buttons, r)
		}
		if visible(widget) && isType(widget, api.imageType()) {
			for parent := api.getParent(widget); parent != 0; parent = api.getParent(parent) {
				parentStyle := api.getStyle(parent)
				if visible(parent) && hasClass(parentStyle, "titlebutton") && (hasClass(parentStyle, "minimize") || hasClass(parentStyle, "maximize") || hasClass(parentStyle, "close")) {
					icons = append(icons, getPixelSize(widget))
					break
				}
			}
		}
		if isType(widget, containerType()) {
			forall(widget, callback, 0)
		}
	})
	deadline := time.Now().Add(5 * time.Second)
	for {
		buttons, icons = nil, nil
		mygo.RunOnMain(func() { forall(win.NativeHandle(), callback, 0) })
		width, err := mygo.EvalAs[float64](win.Page(), "innerWidth")
		if err != nil {
			t.Fatal(err)
		}
		scale := float64(win.ContentBounds().Width) / width
		ready := len(buttons) == 3 && len(icons) == 3
		for _, button := range buttons {
			center := (float64(button.Y) + float64(button.Height)/2) / scale
			ready = ready && float64(button.Width)/scale >= 40 && float64(button.Height)/scale >= 40 && center >= 25 && center <= 27
		}
		for _, size := range icons {
			ready = ready && float64(size)/scale >= 19.5
		}
		if ready {
			return buttons
		}
		if time.Now().After(deadline) {
			t.Fatalf("native title targets/symbols did not settle at scale %v: buttons=%+v symbols=%v", scale, buttons, icons)
		}
		time.Sleep(15 * time.Millisecond)
	}
}
