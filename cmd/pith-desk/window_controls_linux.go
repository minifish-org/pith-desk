package main

import (
	"context"
	"fmt"
	"log"
	"math"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ebitengine/purego"
	"github.com/egoist/mygo"
)

// MyGo 0.3.6 reports GTK logical pixels as CSS pixels. WebKitGTK also
// incorporates text DPI, which can differ from GTK widget scale. Keep GTK's
// existing buttons and actions, sizing them in the page's units.
func prepareDesktopWindowControls(opts *mygo.WindowOptions) {
	opts.Page.PreloadScript = `(() => {
		let room, nativeScale = 1;
		const apply = () => {
			if (!room || !document.documentElement) return;
			const style = document.documentElement.style;
			for (const [key,value] of Object.entries(room)) {
				const name = key === 'height' ? 'height' : 'inset-' + key;
				style.setProperty('--mygo-titlebar-' + name, (value / nativeScale) + 'px');
			}
		};
		window.mygo.on('mygo:title-bar', value => { room = value; apply(); });
		window.addEventListener('desk:native-control-scale', event => { nativeScale = event.detail; apply(); });
		window.addEventListener('resize', apply);
		document.addEventListener('DOMContentLoaded', apply, {once:true});
	})();`
}

type gtkControlsAPI struct {
	cssNew         func() uintptr
	cssLoad        func(uintptr, string, int, uintptr) bool
	getScreen      func(uintptr) uintptr
	getStyle       func(uintptr) uintptr
	getSettings    func(uintptr) uintptr
	addClass       func(uintptr, string)
	addProvider    func(uintptr, uintptr, uint32)
	removeProvider func(uintptr, uintptr)
	unref          func(uintptr)
	connect        func(uintptr, string, uintptr, uintptr, uintptr, uint32) uint64
	disconnect     func(uintptr, uint64)
	forall         func(uintptr, uintptr, uintptr)
	containerType  func() uintptr
	webviewType    func() uintptr
	isType         func(uintptr, uintptr) bool
	imageType      func() uintptr
	getParent      func(uintptr) uintptr
	hasClass       func(uintptr, string) bool
	setPixelSize   func(uintptr, int32)
}

var controlsGTK struct {
	sync.Once
	api      gtkControlsAPI
	err      error
	callback uintptr
	walk     uintptr
	icons    uintptr
	refresh  sync.Map
}

func linuxControlsAPI() (*gtkControlsAPI, error) {
	controlsGTK.Do(func() {
		lib, err := purego.Dlopen("libgtk-3.so.0", purego.RTLD_LAZY|purego.RTLD_GLOBAL)
		if err != nil {
			controlsGTK.err = err
			return
		}
		api := &controlsGTK.api
		purego.RegisterLibFunc(&api.cssNew, lib, "gtk_css_provider_new")
		purego.RegisterLibFunc(&api.cssLoad, lib, "gtk_css_provider_load_from_data")
		purego.RegisterLibFunc(&api.getScreen, lib, "gtk_widget_get_screen")
		purego.RegisterLibFunc(&api.getStyle, lib, "gtk_widget_get_style_context")
		purego.RegisterLibFunc(&api.getSettings, lib, "gtk_widget_get_settings")
		purego.RegisterLibFunc(&api.addClass, lib, "gtk_style_context_add_class")
		purego.RegisterLibFunc(&api.addProvider, lib, "gtk_style_context_add_provider_for_screen")
		purego.RegisterLibFunc(&api.removeProvider, lib, "gtk_style_context_remove_provider_for_screen")
		purego.RegisterLibFunc(&api.unref, lib, "g_object_unref")
		purego.RegisterLibFunc(&api.connect, lib, "g_signal_connect_data")
		purego.RegisterLibFunc(&api.disconnect, lib, "g_signal_handler_disconnect")
		purego.RegisterLibFunc(&api.forall, lib, "gtk_container_forall")
		purego.RegisterLibFunc(&api.containerType, lib, "gtk_container_get_type")
		purego.RegisterLibFunc(&api.isType, lib, "g_type_check_instance_is_a")
		purego.RegisterLibFunc(&api.imageType, lib, "gtk_image_get_type")
		purego.RegisterLibFunc(&api.getParent, lib, "gtk_widget_get_parent")
		purego.RegisterLibFunc(&api.hasClass, lib, "gtk_style_context_has_class")
		purego.RegisterLibFunc(&api.setPixelSize, lib, "gtk_image_set_pixel_size")
		web, err := purego.Dlopen("libwebkit2gtk-4.1.so.0", purego.RTLD_LAZY|purego.RTLD_GLOBAL)
		if err != nil {
			controlsGTK.err = err
			return
		}
		purego.RegisterLibFunc(&api.webviewType, web, "webkit_web_view_get_type")
		controlsGTK.callback = purego.NewCallback(func(_, _, handle uintptr) {
			if refresh, ok := controlsGTK.refresh.Load(handle); ok {
				refresh.(func())()
			}
		})
		controlsGTK.walk = purego.NewCallback(func(widget, handle uintptr) {
			if api.isType(widget, api.webviewType()) {
				api.connect(widget, "notify::zoom-level", controlsGTK.callback, handle, 0, 0)
			} else if api.isType(widget, api.containerType()) {
				api.forall(widget, controlsGTK.walk, handle)
			}
		})
		controlsGTK.icons = purego.NewCallback(func(widget, size uintptr) {
			if api.isType(widget, api.imageType()) {
				for parent := api.getParent(widget); parent != 0; parent = api.getParent(parent) {
					if api.hasClass(api.getStyle(parent), "titlebutton") {
						api.setPixelSize(widget, int32(size))
						return
					}
				}
			} else if api.isType(widget, api.containerType()) {
				api.forall(widget, controlsGTK.icons, size)
			}
		})
	})
	return &controlsGTK.api, controlsGTK.err
}

func linuxControlsCSS(scale float64) string {
	return fmt.Sprintf(`window.pith-desk headerbar.mygo-window-controls { min-height: %.3fpx; padding: 0 %.3fpx; }
		window.pith-desk headerbar.mygo-window-controls button.titlebutton { min-width: %.3fpx; min-height: %.3fpx; padding: 0; margin: 0; color: inherit; background-image: none; }
		window.pith-desk headerbar.mygo-window-controls button.titlebutton:hover { background-color: alpha(currentColor,.12); }
		window.pith-desk headerbar.mygo-window-controls button.titlebutton:active { background-color: alpha(currentColor,.18); }`, 52*scale, 4*scale, 40*scale, 40*scale)
}

func installDesktopWindowControls(win *mygo.Window) func() {
	api, err := linuxControlsAPI()
	if err != nil {
		log.Printf("Linux window controls: %v", err)
		return func() {}
	}
	handle := win.NativeHandle()
	screen, provider := api.getScreen(handle), api.cssNew()
	api.addClass(api.getStyle(handle), "pith-desk")
	api.addProvider(screen, provider, 601)
	load := func(scale float64) { css := linuxControlsCSS(scale); api.cssLoad(provider, css, len(css), 0) }
	load(1)
	var generation atomic.Uint64
	var closed atomic.Bool
	var lastScale float64
	refresh := func() {
		if closed.Load() {
			return
		}
		id := generation.Add(1)
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			viewport, err := win.Page().EvalContext(ctx, "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(innerWidth))))")
			if err != nil || closed.Load() || generation.Load() != id {
				return
			}
			width, ok := viewport.(float64)
			if !ok || width <= 0 {
				return
			}
			var normalizer float64
			mygo.RunOnMain(func() {
				if closed.Load() || generation.Load() != id {
					return
				}
				scale := float64(win.ContentBounds().Width) / width
				if scale <= 0 || math.IsNaN(scale) || math.IsInf(scale, 0) {
					return
				}
				if math.Abs(lastScale-scale) > .001 {
					load(scale)
					lastScale = scale
				}
				// GTK rebuilds these images when maximizing or changing its
				// decoration layout. Resize the current images on each refresh.
				api.forall(handle, controlsGTK.icons, uintptr(math.Round(20*scale)))
				normalizer = scale / win.Page().ZoomFactor()
			})
			if normalizer > 0 && !closed.Load() && generation.Load() == id {
				_, _ = win.Page().EvalContext(ctx, fmt.Sprintf("window.dispatchEvent(new CustomEvent('desk:native-control-scale',{detail:%.10f})); return true;", normalizer))
			}
		}()
	}
	offDOM, offResize := win.Page().OnDOMReady(refresh), win.OnResize(refresh)
	controlsGTK.refresh.Store(handle, refresh)
	settings := api.getSettings(handle)
	dpiSignal := api.connect(settings, "notify::gtk-xft-dpi", controlsGTK.callback, handle, 0, 0)
	// GTK removes this widget's own handler when it destroys the window.
	api.connect(handle, "notify::scale-factor", controlsGTK.callback, handle, 0, 0)
	api.forall(handle, controlsGTK.walk, handle)
	var once sync.Once
	cleanup := func() {
		once.Do(func() {
			closed.Store(true)
			controlsGTK.refresh.Delete(handle)
			offDOM()
			offResize()
			mygo.RunOnMain(func() { api.disconnect(settings, dpiSignal); api.removeProvider(screen, provider); api.unref(provider) })
		})
	}
	win.OnClosed(cleanup)
	return cleanup
}
