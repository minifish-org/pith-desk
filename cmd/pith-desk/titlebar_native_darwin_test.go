package main

import (
	"fmt"
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
	var win *desktopWindow
	mygo.RunOnMain(func() {
		win = newNativeTestWindow(t, server)
	})
	defer win.Destroy()
	if err := win.Page().LoadURL(server.URL); err != nil {
		t.Fatal(err)
	}
	win.Show()
	win.Focus()
	waitNativeDropCondition(t, win, `document.visibilityState==='visible' && document.hasFocus()`)
	waitNativeDropCondition(t, win, `!!document.querySelector('.app-root.titlebar-overlay header') && !!document.querySelector('[data-sidebar-bottom] button')`)
	if nativeDropEval(t, win, `(() => {
		const root = document.querySelector('.app-root.titlebar-overlay'),header = root.querySelector('header'),
			nav = root.querySelector('[data-navigation-rail]'),brand = root.querySelector('[data-brand]'),
			navRow = nav.querySelector('[data-rail-heading]'),spacer = root.querySelector('[data-titlebar-spacer]'),
			close = nav.querySelector('button[aria-label="Close navigation"]');
		const native = getComputedStyle(document.documentElement),height = parseFloat(native.getPropertyValue('--mygo-titlebar-height')),
			left = parseFloat(native.getPropertyValue('--mygo-titlebar-inset-left'));
		const h = header.getBoundingClientRect(),n = nav.getBoundingClientRect(),t = spacer.getBoundingClientRect(),r = navRow.getBoundingClientRect(),b = brand.getBoundingClientRect(),c = close.getBoundingClientRect();
		return height === 52 && left > 0 && Math.abs(h.y) <= 1 && Math.abs(h.height - 52) <= 1
			&& Math.abs(t.y) <= 1 && Math.abs(t.height - 52) <= 1 && Math.abs(t.width - n.width) <= 1
			&& c.y >= 0 && c.y + c.height <= 52 && t.y <= c.y
			&& b.y >= 52 && r.y >= 52 && Math.abs(r.height - 44) <= 1
			&& getComputedStyle(header).getPropertyValue('--app-region').trim() === 'drag'
			&& root.querySelectorAll('[data-brand]').length === 1
			&& root.querySelectorAll('[data-tools-rail]').length === 1;
	})()`) != true {
		t.Fatal("native window controls and the brand row diverged")
	}
	if nativeDropEval(t, win, `(() => {
		const action = [...document.querySelectorAll('header button')].find(button => button.getAttribute('aria-label') === 'Compact'),event = new MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0});
		action.dispatchEvent(event);
		return getComputedStyle(action).getPropertyValue('--app-region').trim() === 'no-drag' && !event.defaultPrevented;
	})()`) != true {
		t.Fatal("the native drag handler intercepted an existing titlebar control")
	}
	nativeDropEval(t, win, `[...document.querySelectorAll('[data-sidebar-bottom] button')].find(button => button.textContent.trim() === 'Settings').click(); return true;`)
	waitNativeDropCondition(t, win, `document.querySelector('[role="dialog"]') !== null`)
	nativeDropEval(t, win, `document.querySelector('[data-slot="dialog-close"]').click(); return true;`)
	waitNativeDropCondition(t, win, `document.querySelector('[role="dialog"]') === null`)
	nativeDropEval(t, win, `document.querySelector('button[aria-label="Toggle tools"]').click();return true;`)
	waitNativeDropCondition(t, win, `!!document.querySelector('[data-tools-rail] button[aria-label="Close tools"]') && document.querySelector('[data-tools-rail]').getBoundingClientRect().width > 200`)
	if nativeDropEval(t, win, `(() => {
		const root=document.querySelector('.app-root'),native=getComputedStyle(document.documentElement),left=parseFloat(native.getPropertyValue('--mygo-titlebar-inset-left'));
		const header=root.querySelector('header').getBoundingClientRect(),tools=root.querySelector('[data-tools-rail]').getBoundingClientRect(),spacer=root.querySelector('[data-titlebar-spacer]').getBoundingClientRect();
		const navClose=root.querySelector('button[aria-label="Close navigation"]'),toolsClose=root.querySelector('button[aria-label="Close tools"]');
		const nc=navClose.getBoundingClientRect(),tc=toolsClose.getBoundingClientRect(),navPanel=root.querySelector('[data-navigation-rail]').getBoundingClientRect();
		return Math.abs(header.height-52)<=1 && Math.abs(tools.y)<=1 && Math.abs(spacer.height-52)<=1
			&& nc.y>=0 && nc.y+nc.height<=52 && Math.abs(nc.y+nc.height/2-(spacer.y+spacer.height/2))<=1 && nc.x>=navPanel.x && nc.x+nc.width<=navPanel.x+navPanel.width && nc.x>=left && getComputedStyle(navClose).getPropertyValue('--app-region').trim()==='no-drag'
			&& tc.y>=0 && tc.y+tc.height<=52 && Math.abs(tc.y+tc.height/2-(header.y+header.height/2))<=1 && tc.x>=tools.x && tc.x+tc.width<=tools.x+tools.width && getComputedStyle(toolsClose).getPropertyValue('--app-region').trim()==='no-drag'
			&& root.querySelectorAll('header button[aria-label^="Toggle "]').length===0;
	})()`) != true {
		t.Fatal("native sidebar close controls left the titlebar row or its non-draggable regions")
	}
	nativeDropEval(t, win, `for(const [name,key] of [['Resize navigation','ArrowRight'],['Resize tools','ArrowLeft']]) {
		const handle=document.querySelector('[role="separator"][aria-label="'+name+'"]');handle.focus();
		handle.dispatchEvent(new KeyboardEvent('keydown',{key,shiftKey:true,bubbles:true}));
	}return true;`)
	waitNativeDropCondition(t, win, `document.querySelector('[data-navigation-rail]').getBoundingClientRect().width>270 && document.querySelector('[data-tools-rail]').getBoundingClientRect().width>310 && document.querySelector('main').getBoundingClientRect().width>=320`)
	deadline := time.Now().Add(5 * time.Second)
	var navWidth, toolsWidth int
	for {
		settings := service.Snapshot().Settings
		navWidth, toolsWidth = settings.NavigationWidth, settings.ToolsWidth
		if navWidth > 260 && toolsWidth > 300 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("native sidebar preferences were not saved: %d/%d", navWidth, toolsWidth)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if nativeDropEval(t, win, fmt.Sprintf(`Math.abs(document.querySelector('[data-navigation-rail]').getBoundingClientRect().width-%d)<=1.5 && Math.abs(document.querySelector('[data-tools-rail]').getBoundingClientRect().width-%d)<=1.5`, navWidth, toolsWidth)) != true {
		t.Fatalf("native rails diverged from saved widths %d/%d", navWidth, toolsWidth)
	}
	nativeDropEval(t, win, `window.__sidebarPainted=false;requestAnimationFrame(()=>requestAnimationFrame(()=>window.__sidebarPainted=true));return true;`)
	waitNativeDropCondition(t, win, `window.__sidebarPainted`)
	if nativeDropEval(t, win, fmt.Sprintf(`(() => {
		const rail=document.querySelector('[data-navigation-rail]'),handle=document.querySelector('[role="separator"][aria-label="Resize navigation"]'),edge=handle.getBoundingClientRect();
		return Math.abs(rail.getBoundingClientRect().width-%d)<=1.5 && getComputedStyle(handle).getPropertyValue('--app-region').trim()==='no-drag' && document.elementFromPoint(edge.x+edge.width/2,80)===handle;
	})()`, navWidth)) != true {
		t.Fatal("native resize diverged from the window-controls row")
	}
	saveUsabilityScreenshot(t, win, "sidebar-controls-wide.png")
	nativeDropEval(t, win, `const button=document.querySelector('button[aria-label="Close tools"]');button.focus();button.click();return true;`)
	waitNativeDropCondition(t, win, `document.activeElement===document.querySelector('header button[aria-label="Toggle tools"]')`)
	nativeDropEval(t, win, `const button=document.querySelector('button[aria-label="Close navigation"]');button.focus();button.click();return true;`)
	waitNativeDropCondition(t, win, `document.activeElement===document.querySelector('header button[aria-label="Toggle navigation"]') && !!document.querySelector('header button[aria-label="Toggle tools"]')`)
	nativeDropEval(t, win, `document.querySelector('header button[aria-label="Toggle navigation"]').click();return true;`)
	saveUsabilityScreenshot(t, win, "titlebar-fusion.png")
	win.SetSize(480, 700)
	win.Show()
	win.Focus()
	waitNativeDropCondition(t, win, `innerWidth === 480 && document.querySelector('[data-select-value]').getBoundingClientRect().width <= 1`)
	time.Sleep(300 * time.Millisecond)
	if nativeDropEval(t, win, `(() => {
		const native=getComputedStyle(document.documentElement),rows=[...document.querySelectorAll('[data-composer-context],[data-composer-actions]')];
		const buttons=rows.flatMap(row=>[...row.querySelectorAll('button')]).filter(node=>node.getBoundingClientRect().width);
		return parseFloat(native.getPropertyValue('--mygo-titlebar-height'))===52 && parseFloat(native.getPropertyValue('--mygo-titlebar-inset-left'))>0
			&& buttons.length>=2 && buttons.every(node=>{const r=node.getBoundingClientRect();return r.x>=0 && r.right<=innerWidth+1 && r.height>=24 && r.width>0;})
			&& rows.every(row=>row.getBoundingClientRect().right<=innerWidth+1);
	})()`) != true {
		t.Fatal("narrow native composer alignment or existing traffic-light insets changed")
	}
	win.Focus()
	waitNativeDropCondition(t, win, `document.visibilityState==='visible' && document.hasFocus() && document.querySelector('.app-root').getBoundingClientRect().height===700 && document.querySelector('.app-root').getBoundingClientRect().width===480 && document.querySelectorAll('[data-navigation-rail]').length===0`)
	nativeDropEval(t, win, `window.__sidebarPainted=false;requestAnimationFrame(()=>requestAnimationFrame(()=>window.__sidebarPainted=true));return true;`)
	waitNativeDropCondition(t, win, `window.__sidebarPainted`)
	saveUsabilityScreenshot(t, win, "titlebar-narrow.png")
	for _, name := range []string{"navigation", "tools"} {
		win.Focus()
		waitNativeDropCondition(t, win, `document.visibilityState==='visible' && document.hasFocus()`)
		nativeDropEval(t, win, `document.querySelector('header button[aria-label="Toggle `+name+`"]').click();return true;`)
		waitNativeDropCondition(t, win, `document.activeElement===document.querySelector('button[aria-label="Close `+name+`"]') && document.activeElement.getBoundingClientRect().y<52`)
		nativeDropEval(t, win, `document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return true;`)
		waitNativeDropCondition(t, win, `document.activeElement===document.querySelector('header button[aria-label="Toggle `+name+`"]') && !document.querySelector('main').inert`)
	}
}
