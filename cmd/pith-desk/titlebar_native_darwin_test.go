package main

import (
	"os"
	"testing"

	"github.com/egoist/mygo"
	"github.com/minifish-org/pith-desk/internal/desk"
)

func TestTitlebarNativeOverlayAndExistingControls(t *testing.T) {
	if os.Getenv("PITH_DESK_NATIVE_SMOKE") != "1" {
		t.Skip("set PITH_DESK_NATIVE_SMOKE=1 for native titlebar verification")
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
	server, err := startNativeSmokeHost(service)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	server.SetTitlebarOverlay(true)
	var win *mygo.Window
	mygo.RunOnMain(func() {
		opts := desktopWindowOptions()
		opts.Title = "Pith Desk titlebar smoke"
		opts.StateKey = ""
		win = mygo.NewWindow(opts)
	})
	defer win.Destroy()
	if err := win.Page().LoadURL(server.URL); err != nil {
		t.Fatal(err)
	}
	waitNativeDropCondition(t, win, `!!document.querySelector('.pui-titlebar-overlay .pui-topbar') && !!document.querySelector('.pui-sidebar-bottom button')`)
	if nativeDropEval(t, win, `(() => {
		const root = document.querySelector('.pui-titlebar-overlay'),strip = root.querySelector('.pui-native-titlebar'),
			header = root.querySelector('.pui-topbar'),sidebar = root.querySelector('.pui-sidebar'),brand = root.querySelector('.pui-brand');
		const native = getComputedStyle(document.documentElement),height = parseFloat(native.getPropertyValue('--mygo-titlebar-height')),
			left = parseFloat(native.getPropertyValue('--mygo-titlebar-inset-left'));
		const h = header.getBoundingClientRect(),s = strip.getBoundingClientRect();
		return height === 52 && left > 0 && h.y === 0 && h.height === 52 && s.y === h.y && s.height === height
			&& s.width === sidebar.getBoundingClientRect().width && brand.getBoundingClientRect().y >= height
			&& getComputedStyle(header).getPropertyValue('--app-region').trim() === 'drag'
			&& strip.childElementCount === 0 && root.querySelectorAll('.pui-brand').length === 1 && root.querySelectorAll('aside').length === 2
			&& getComputedStyle(root.querySelector('.pui-tools')).display === 'none';
	})()`) != true {
		t.Fatal("native window controls and the existing frame did not share the titlebar")
	}
	if nativeDropEval(t, win, `(() => {
		const action = document.querySelector('.pui-topbar button'),event = new MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0});
		action.dispatchEvent(event);
		return getComputedStyle(action).getPropertyValue('--app-region').trim() === 'no-drag' && !event.defaultPrevented;
	})()`) != true {
		t.Fatal("the native drag handler intercepted an existing titlebar control")
	}
	nativeDropEval(t, win, `Array.from(document.querySelectorAll('.pui-sidebar-bottom button')).find(button => button.textContent === 'Settings').click(); return true;`)
	waitNativeDropCondition(t, win, `document.querySelector('dialog[open]') !== null`)
	nativeDropEval(t, win, `document.querySelector('dialog[open]').close(); return true;`)
	waitNativeDropCondition(t, win, `document.querySelector('dialog[open]') === null`)
	saveUsabilityScreenshot(t, win, "titlebar-fusion.png")
	win.SetSize(480, 700)
	win.Show()
	waitNativeDropCondition(t, win, `innerWidth === 480 && document.querySelector('.pui-permission-control .pui-select-value').getBoundingClientRect().width <= 1`)
	if nativeDropEval(t, win, `(() => {
		const native=getComputedStyle(document.documentElement),buttons=[...document.querySelectorAll('.pui-composer-context > *, .pui-composer-actions > *')].filter(node=>node.getBoundingClientRect().width);
		const centers=buttons.map(node=>{const r=node.getBoundingClientRect();return r.y+r.height/2;});
		return parseFloat(native.getPropertyValue('--mygo-titlebar-height'))===52 && parseFloat(native.getPropertyValue('--mygo-titlebar-inset-left'))>0 && Math.max(...centers)-Math.min(...centers)<=1;
	})()`) != true {
		t.Fatal("narrow native composer alignment or existing traffic-light insets changed")
	}
	saveUsabilityScreenshot(t, win, "titlebar-narrow.png")
}
