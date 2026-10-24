package main

import (
	"io"
	"os"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/egoist/mygo"
	"github.com/minifish-org/pith-desk/internal/desk"
)

func TestWorkspaceBrowserNativeSidebarPreviewReferenceAndSave(t *testing.T) {
	if os.Getenv("PITH_DESK_NATIVE_SMOKE") != "1" {
		t.Skip("set PITH_DESK_NATIVE_SMOKE=1 for native workspace acceptance")
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
	conversation, err := service.CreateConversation(workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.SaveDraft(desk.DraftInput{DraftScope: desk.DraftScope{ID: conversation.ID}, Draft: desk.Draft{Text: "Stored draft", Revision: 1}}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(workspace.Path, "Native 中文.md")
	if err := os.WriteFile(path, []byte("# Native workspace preview"), 0600); err != nil {
		t.Fatal(err)
	}
	server, err := startNativeSmokeHost(service)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	server.SetTitlebarOverlay(true)
	var opened, revealed, copied, saved, automatic atomic.Int32
	server.SetFileActions(func(p string) error {
		if p != path {
			t.Errorf("wrong open target: %s", p)
		}
		opened.Add(1)
		return nil
	}, func(p string) error {
		if p != path {
			t.Errorf("wrong reveal target: %s", p)
		}
		revealed.Add(1)
		return nil
	})
	server.SetClipboardActions(func(string) error { return nil }, func(p string) error {
		if p != path {
			t.Errorf("wrong copy target: %s", p)
		}
		copied.Add(1)
		return nil
	})
	server.SetFileDownloadAction(func(name string, file io.Reader) error {
		data, err := io.ReadAll(file)
		if name != "Native 中文.md" || string(data) != "# Native workspace preview" {
			t.Error("native save content changed")
		}
		saved.Add(1)
		return err
	})
	var win *desktopWindow
	mygo.RunOnMain(func() {
		opts := desktopWindowOptions()
		opts.Title = "Pith Desk workspace smoke"
		opts.StateKey = ""
		opts.Hidden = true
		win = newNativeTestWindow(t, opts)
		win.Page().OnWillDownload(func(event *mygo.DownloadEvent) { automatic.Add(1); event.PreventDefault() })
	})
	defer win.Destroy()
	if err := win.Page().LoadURL(server.URL); err != nil {
		t.Fatal(err)
	}
	win.Show()
	waitNativeDropCondition(t, win, `!!document.querySelector('button[aria-label="Toggle tools"]') && document.querySelector('textarea')?.value==='Stored draft' && !document.querySelector('textarea').readOnly`)
	nativeDropEval(t, win, `const input = document.querySelector('textarea[aria-label="Message Pith"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Keep draft');input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('button[aria-label="Toggle tools"]').click();return true;`)
	waitNativeDropCondition(t, win, `[...document.querySelectorAll('[data-tools-rail] button')].some(button=>button.textContent.trim()==='Open files')`)
	if nativeDropEval(t, win, `document.querySelectorAll('[data-tools-rail] [role="tab"]').length === 0`) != true {
		t.Fatal("new workspace opened a tool tab before a tool was requested")
	}
	openNativeFilesTab(t, win)
	waitNativeDropCondition(t, win, `[...document.querySelectorAll('[data-tools-rail] button')].some(button=>button.textContent.trim()==='Native 中文.md')`)
	for _, action := range []string{"Open", "Reveal", "Copy file", "Download", "Insert reference"} {
		nativeDropEval(t, win, `const trigger=document.querySelector('[data-tools-rail] button[aria-label="Actions for Native 中文.md"]');for(const type of ['pointerdown','pointerup'])trigger.dispatchEvent(new PointerEvent(type,{bubbles:true,button:0,pointerId:1}));return true;`)
		waitNativeDropCondition(t, win, `[...document.querySelectorAll('[role="menuitem"]')].some(button=>button.textContent===`+strconv.Quote(action)+`)`)
		// UIAction handlers report completion asynchronously, retaining the same
		// native callbacks and authenticated bridge as generated files.
		nativeDropEval(t, win, `[...document.querySelectorAll('[role="menuitem"]')].find(button=>button.textContent===`+strconv.Quote(action)+`).click();return true;`)
		waitNativeDropCondition(t, win, `!document.querySelector('[role="menu"]')`)
	}
	waitNativeDropCondition(t, win, `document.querySelector('textarea').value.includes('Keep draft') && document.querySelector('textarea').value.includes('Native 中文.md')`)
	if opened.Load() != 1 || revealed.Load() != 1 || copied.Load() != 1 || saved.Load() != 1 || automatic.Load() != 0 {
		t.Fatalf("native actions: open=%d reveal=%d copy=%d save=%d browser=%d", opened.Load(), revealed.Load(), copied.Load(), saved.Load(), automatic.Load())
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		nativeDropEval(t, win, `document.querySelector('button[aria-label="Close navigation"]')?.click();return true;`)
		if nativeDropEval(t, win, `!!document.querySelector('button[aria-label="Toggle navigation"]')`) == true {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("navigation did not collapse before narrow resize: %v", nativeDropEval(t, win, `({
				width: innerWidth, height: innerHeight, focused: document.hasFocus(), visibility: document.visibilityState,
				active: document.activeElement?.getAttribute('aria-label'),
				controls: [...document.querySelectorAll('button[aria-label="Close navigation"],button[aria-label="Toggle navigation"]')].map(node=>({label:node.getAttribute('aria-label'),disabled:node.disabled,rect:node.getBoundingClientRect().toJSON()})),
				panels: [...document.querySelectorAll('[data-panel]')].map(node=>({id:node.id,style:node.getAttribute('style'),rect:node.getBoundingClientRect().toJSON()})),
				menu: !!document.querySelector('[role="menu"]'), dialog: !!document.querySelector('[role="dialog"]'),
				error: document.querySelector('[data-inline-error]')?.textContent
			})`))
		}
		time.Sleep(30 * time.Millisecond)
	}
	waitNativeDropCondition(t, win, `document.querySelector('button[aria-label="Toggle navigation"]').getBoundingClientRect().x>=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mygo-titlebar-inset-left')) && document.querySelector('[data-tools-rail]').getBoundingClientRect().width>200`)

	nativeDropEval(t, win, `[...document.querySelectorAll('[data-tools-rail] button')].find(button=>button.textContent.trim()==='Native 中文.md').click();return true;`)
	waitNativeDropCondition(t, win, `document.querySelector('[role="dialog"]')?.textContent.includes('Native workspace preview')`)
	saveUsabilityScreenshot(t, win, "workspace-files-native.png")
	nativeDropEval(t, win, `document.querySelector('[data-slot="dialog-close"]').click();return true;`)
	win.SetSize(480, 700)
	win.Show()
	waitNativeDropCondition(t, win, `innerWidth===480 && !!document.querySelector('button[aria-label="Toggle tools"]') && document.querySelectorAll('[data-tools-rail]').length===0`)
	nativeDropEval(t, win, `document.querySelector('button[aria-label="Toggle tools"]').click();return true;`)
	waitNativeDropCondition(t, win, `!!document.querySelector('[data-drawer-panel]') && !!document.querySelector('[data-drawer-panel] button[aria-label="Close tools"]')`)
	nativeDropEval(t, win, `document.querySelector('[data-drawer-panel] button[aria-label="Close tools"]').click();return true;`)
	deadline = time.Now().Add(5 * time.Second)
	for {
		if nativeDropEval(t, win, `document.activeElement===document.querySelector('button[aria-label="Toggle tools"]') && document.querySelector('textarea').value.includes('Keep draft')`) == true {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("narrow native tools did not restore focus and draft: %v", nativeDropEval(t, win, `JSON.stringify({active:document.activeElement?.getAttribute('aria-label'),draft:document.querySelector('textarea')?.value})`))
		}
		time.Sleep(30 * time.Millisecond)
	}
}
