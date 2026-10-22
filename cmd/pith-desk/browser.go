package main

import (
	"errors"
	"fmt"
	"sync"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
	"github.com/minifish-org/pith-desk/internal/host"
	"github.com/minifish-org/pith-desk/internal/wire"
)

// The native container only places pages. All Desk controls and layout still
// belong to the existing Pith UI interface in the main page.
type desktopWindow struct {
	*mygo.Window
	main     *mygo.WebView
	mu       sync.Mutex
	tabs     map[string]*mygo.WebView
	shown    string
	bounds   wire.BrowserBounds
	titlebar ui.TitleBar
	zoom     float64
}

func newDesktopWindow(opts mygo.WindowOptions) (*desktopWindow, error) {
	w := &desktopWindow{tabs: make(map[string]*mygo.WebView)}
	opts.Content = ui.View(func(c *ui.Context) {
		w.mu.Lock()
		main, preview, b := w.main, w.tabs[w.shown], w.bounds
		w.mu.Unlock()
		if main != nil {
			bar := c.TitleBar()
			zoom := w.Page().ZoomFactor()
			if bar != w.titlebar || zoom != w.zoom {
				w.titlebar = bar
				w.zoom = zoom
				w.applyTitlebar()
			}
		}
		ui.Column(c).Fill().Children(func() {
			if main != nil {
				ui.WebView(c, main).Fill()
			}
			if preview != nil {
				ui.WebView(c, preview).Absolute().Left(float32(b.X)).Top(float32(b.Y)).Width(float32(b.Width)).Height(float32(b.Height))
			}
		})
	})
	w.Window = mygo.NewWindow(opts)
	page, err := w.NewWebView(mygo.WebViewOptions{BackgroundColor: opts.BackgroundColor})
	if err != nil {
		w.Window.Destroy()
		return nil, err
	}
	w.mu.Lock()
	w.main = page
	w.mu.Unlock()
	w.Invalidate()
	w.Page().OnDidNavigate(func(string) { w.closeBrowsers() })
	w.Page().OnDOMReady(w.applyTitlebar)
	return w, nil
}

func (w *desktopWindow) Page() *mygo.Page             { return w.main.Page() }
func (w *desktopWindow) CapturePage() ([]byte, error) { return w.main.CapturePage() }

func (w *desktopWindow) installBrowser(server *host.Server) {
	server.SetBrowserActions(func(id, workspace, address string) error {
		var result error
		mygo.RunOnMain(func() {
			w.mu.Lock()
			v := w.tabs[id]
			w.mu.Unlock()
			if v == nil {
				v, result = w.NewWebView(mygo.WebViewOptions{})
				if result != nil {
					return
				}
				v.Page().SetPermissionHandler(func(mygo.PermissionRequest) bool { return false })
				v.Page().OnWillDownload(func(e *mygo.DownloadEvent) { e.PreventDefault() })
				v.Page().OnWillNavigate(func(e *mygo.NavigateEvent) {
					if server.BrowserIntent(workspace, e.URL) != nil {
						e.PreventDefault()
					}
				})
				v.Page().SetWindowOpenHandler(func(req mygo.WindowOpenRequest) *mygo.WindowOptions {
					if server.BrowserIntent(workspace, req.URL) == nil {
						go mygo.Shell.OpenExternal(req.URL)
					}
					return nil
				})
				w.mu.Lock()
				w.tabs[id] = v
				w.mu.Unlock()
			}
			result = v.Page().LoadURL(address)
		})
		return result
	}, func(in wire.BrowserViewInput) error {
		var result error
		mygo.RunOnMain(func() {
			zoom := w.Page().ZoomFactor()
			w.mu.Lock()
			if in.Bounds != nil {
				if w.tabs[in.ID] == nil {
					w.mu.Unlock()
					result = errors.New("Browser tab was closed")
					return
				}
				w.shown = in.ID
				b := *in.Bounds
				w.bounds = wire.BrowserBounds{X: b.X * zoom, Y: b.Y * zoom, Width: b.Width * zoom, Height: b.Height * zoom}
			} else if w.shown == in.ID {
				w.shown = ""
				w.main.Focus()
			}
			w.mu.Unlock()
			w.Invalidate()
		})
		return result
	}, w.closeBrowser)
}

func (w *desktopWindow) closeBrowser(id string) {
	mygo.RunOnMain(func() {
		w.mu.Lock()
		v := w.tabs[id]
		delete(w.tabs, id)
		if w.shown == id {
			w.shown = ""
		}
		w.mu.Unlock()
		if v != nil {
			v.Destroy()
		}
		w.Invalidate()
	})
}
func (w *desktopWindow) closeBrowsers() {
	w.mu.Lock()
	ids := make([]string, 0, len(w.tabs))
	for id := range w.tabs {
		ids = append(ids, id)
	}
	w.mu.Unlock()
	for _, id := range ids {
		w.closeBrowser(id)
	}
}

// MyGo exposes container titlebar metrics through ui.Context. Its child pages
// have no titlebar of their own; project the public metrics into the existing
// Pith UI titlebar contract, including fullscreen and page zoom.
func (w *desktopWindow) applyTitlebar() {
	b := w.titlebar
	zoom := w.Page().ZoomFactor()
	if zoom <= 0 {
		zoom = 1
	}
	w.Page().Eval(fmt.Sprintf(`(()=>{const s=document.documentElement.style;s.setProperty('--mygo-titlebar-height','%gpx');s.setProperty('--mygo-titlebar-inset-left','%gpx');s.setProperty('--mygo-titlebar-inset-right','%gpx')})()`, float64(b.Height)/zoom, float64(b.Left)/zoom, float64(b.Right)/zoom))
}
func (w *desktopWindow) Focus() { w.Window.Focus(); w.main.Focus() }
