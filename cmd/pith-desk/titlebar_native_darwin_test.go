package main

import (
	"os"
	"testing"
	"time"

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
	win.Show()
	win.Focus()
	waitNativeDropCondition(t, win, `document.visibilityState==='visible' && document.hasFocus()`)
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
		const action = document.querySelector('.pui-topbar button[aria-label="Compress context"]'),event = new MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0});
		action.dispatchEvent(event);
		return getComputedStyle(action).getPropertyValue('--app-region').trim() === 'no-drag' && !event.defaultPrevented;
	})()`) != true {
		t.Fatal("the native drag handler intercepted an existing titlebar control")
	}
	nativeDropEval(t, win, `Array.from(document.querySelectorAll('.pui-sidebar-bottom button')).find(button => button.textContent === 'Settings').click(); return true;`)
	waitNativeDropCondition(t, win, `document.querySelector('dialog[open]') !== null`)
	nativeDropEval(t, win, `document.querySelector('dialog[open]').close(); return true;`)
	waitNativeDropCondition(t, win, `document.querySelector('dialog[open]') === null`)
	nativeDropEval(t, win, `document.querySelector('button[aria-label="Toggle tools"]').click();return true;`)
	waitNativeDropCondition(t, win, `!!document.querySelector('.pui-tools button[aria-label="Close tools"]') && !document.querySelector('.pui-tools').inert`)
	if nativeDropEval(t, win, `(() => {
		const root=document.querySelector('.pui-app'),native=getComputedStyle(document.documentElement),left=parseFloat(native.getPropertyValue('--mygo-titlebar-inset-left'));
		const header=root.querySelector('.pui-topbar').getBoundingClientRect(),tabs=root.querySelector('.pui-tool-tabs-heading').getBoundingClientRect();
		return header.height===52 && tabs.height===header.height && tabs.y===header.y && [['Close navigation','.pui-sidebar:not(.pui-tools)'],['Close tools','.pui-tools']].every(([name,selector])=>{
			const button=root.querySelector('button[aria-label="'+name+'"]'),panel=root.querySelector(selector),b=button.getBoundingClientRect(),p=panel.getBoundingClientRect();
			return b.y>=0 && b.y+b.height<=52 && Math.abs(b.y+b.height/2-(header.y+header.height/2))<=1 && b.x>=p.x && b.x+b.width<=p.x+p.width && (name!=='Close navigation'||b.x>=left) && getComputedStyle(button).getPropertyValue('--app-region').trim()==='no-drag';
		}) && [...root.querySelectorAll('.pui-topbar .pui-sidebar-trigger')].every(button=>button.hidden);
	})()`) != true {
		t.Fatal("expanded native rails do not own their top controls")
	}
	nativeDropEval(t, win, `for(const [name,key] of [['Resize navigation','ArrowRight'],['Resize tools','ArrowLeft']]) {
		const handle=document.querySelector('[role="separator"][aria-label="'+name+'"]');handle.focus();
		handle.dispatchEvent(new KeyboardEvent('keydown',{key,shiftKey:true,bubbles:true}));handle.dispatchEvent(new KeyboardEvent('keyup',{key,bubbles:true}));
	}return true;`)
	waitNativeDropCondition(t, win, `document.querySelector('[aria-label="Resize navigation"]').getAttribute('aria-valuenow')==='300' && document.querySelector('[aria-label="Resize tools"]').getAttribute('aria-valuenow')==='340' && document.querySelector('main').getBoundingClientRect().width>=320`)
	deadline := time.Now().Add(5 * time.Second)
	for {
		settings := service.Snapshot().Settings
		if settings.NavigationWidth == 300 && settings.ToolsWidth == 340 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("native sidebar preferences were not saved")
		}
		time.Sleep(20 * time.Millisecond)
	}
	nativeDropEval(t, win, `window.__sidebarPainted=false;requestAnimationFrame(()=>requestAnimationFrame(()=>window.__sidebarPainted=true));return true;`)
	waitNativeDropCondition(t, win, `window.__sidebarPainted`)
	if nativeDropEval(t, win, `(() => {
		const rail=document.querySelector('.pui-sidebar'),strip=document.querySelector('.pui-native-titlebar'),handle=rail.querySelector('[role="separator"]'),edge=handle.getBoundingClientRect();
		return rail.getBoundingClientRect().width===300 && strip.getBoundingClientRect().width===300 && getComputedStyle(handle).getPropertyValue('--app-region').trim()==='no-drag' && document.elementFromPoint(edge.x+edge.width/2,80)===handle;
	})()`) != true {
		t.Fatalf("native resize diverged from the window-controls row: %v", nativeDropEval(t, win, `({rail:document.querySelector('.pui-sidebar').getBoundingClientRect().toJSON(),strip:document.querySelector('.pui-native-titlebar').getBoundingClientRect().toJSON(),drag:getComputedStyle(document.querySelector('.pui-sidebar [role="separator"]')).getPropertyValue('--app-region')})`))
	}
	saveUsabilityScreenshot(t, win, "sidebar-controls-wide.png")
	nativeDropEval(t, win, `document.querySelector('button[aria-label="Close tools"]').click();document.querySelector('button[aria-label="Close navigation"]').click();return true;`)
	waitNativeDropCondition(t, win, `document.activeElement===document.querySelector('button[aria-label="Toggle navigation"]') && !document.activeElement.hidden && !document.querySelector('button[aria-label="Toggle tools"]').hidden`)
	nativeDropEval(t, win, `document.querySelector('button[aria-label="Toggle navigation"]').click();return true;`)
	saveUsabilityScreenshot(t, win, "titlebar-fusion.png")
	win.SetSize(480, 700)
	win.Show()
	win.Focus()
	waitNativeDropCondition(t, win, `innerWidth === 480 && document.querySelector('.pui-permission-control .pui-select-value').getBoundingClientRect().width <= 1`)
	if nativeDropEval(t, win, `(() => {
		const native=getComputedStyle(document.documentElement),buttons=[...document.querySelectorAll('.pui-composer-context > *, .pui-composer-actions > *')].filter(node=>node.getBoundingClientRect().width);
		const centers=buttons.map(node=>{const r=node.getBoundingClientRect();return r.y+r.height/2;});
		return parseFloat(native.getPropertyValue('--mygo-titlebar-height'))===52 && parseFloat(native.getPropertyValue('--mygo-titlebar-inset-left'))>0 && Math.max(...centers)-Math.min(...centers)<=1;
	})()`) != true {
		t.Fatal("narrow native composer alignment or existing traffic-light insets changed")
	}
	waitNativeDropCondition(t, win, `document.querySelector('.pui-app').getBoundingClientRect().height===700 && document.querySelector('.pui-app').getBoundingClientRect().width===480 && [...document.querySelectorAll('aside')].every(node=>node.inert && node.classList.contains('pui-overlay-closed'))`)
	nativeDropEval(t, win, `window.__sidebarPainted=false;requestAnimationFrame(()=>requestAnimationFrame(()=>window.__sidebarPainted=true));return true;`)
	waitNativeDropCondition(t, win, `window.__sidebarPainted`)
	saveUsabilityScreenshot(t, win, "titlebar-narrow.png")
	for _, name := range []string{"navigation", "tools"} {
		win.Focus()
		waitNativeDropCondition(t, win, `document.visibilityState==='visible' && document.hasFocus()`)
		nativeDropEval(t, win, `document.querySelector('button[aria-label="Toggle `+name+`"]').click();return true;`)
		waitNativeDropCondition(t, win, `document.activeElement===document.querySelector('button[aria-label="Close `+name+`"]') && document.activeElement.getBoundingClientRect().y<52`)
		nativeDropEval(t, win, `document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return true;`)
		waitNativeDropCondition(t, win, `document.activeElement===document.querySelector('button[aria-label="Toggle `+name+`"]') && !document.querySelector('main').inert`)
	}
}
