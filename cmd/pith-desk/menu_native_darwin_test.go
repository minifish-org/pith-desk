package main

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo"
	"github.com/minifish-org/pith-desk/internal/desk"
)

func TestNativeMenuInstalledActionsReachPageAndSave(t *testing.T) {
	if os.Getenv("PITH_DESK_NATIVE_SMOKE") != "1" {
		t.Skip("set PITH_DESK_NATIVE_SMOKE=1 for installed native menu verification")
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
	first, err := service.CreateConversation(workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	server, err := startNativeSmokeHost(service)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	previousMenu := mygo.App.Menu()
	defer func() { mygo.RunOnMain(func() { mygo.App.SetMenu(previousMenu) }) }()
	var win *desktopWindow
	mygo.RunOnMain(func() {
		win = newNativeTestWindow(t, server)
		installNativeMenu(server, win)
	})
	defer win.Destroy()
	var dialogMu sync.Mutex
	exported := filepath.Join(t.TempDir(), "conversation.md")
	installFileSaves(server, func() *mygo.Window { return win.Window }, &dialogMu, func(options mygo.SaveDialogOptions) (string, error) {
		if options.Parent != win.Window || options.Title != "Export conversation" {
			t.Error("menu export did not use the native conversation save dialog")
		}
		return exported, nil
	})
	if err := win.Page().LoadURL(server.URL); err != nil {
		t.Fatal(err)
	}
	win.Show()
	win.Focus()
	waitNativeDropCondition(t, win, `document.querySelector('textarea[aria-label="Message Pith"]')?.readOnly === false`)
	menu := mygo.App.Menu()
	item := func(id string, enabled bool) *mygo.MenuItem {
		t.Helper()
		entry := menu.ItemByID(id)
		if entry == nil || entry.Click == nil {
			t.Fatalf("installed menu has no action %q", id)
		}
		deadline := time.Now().Add(5 * time.Second)
		for entry.IsEnabled() != enabled {
			if time.Now().After(deadline) {
				t.Fatalf("installed menu %s enabled=%v, want %v", id, entry.IsEnabled(), enabled)
			}
			time.Sleep(15 * time.Millisecond)
		}
		return entry
	}
	click := func(entry *mygo.MenuItem) { mygo.RunOnMain(func() { entry.Click(entry, win.Window) }) }
	click(item("desk-settings", true))
	waitNativeDropCondition(t, win, `document.querySelector('[role="dialog"]')?.textContent.includes('Settings')`)
	// The installed controller must reject a callback while its page has a modal.
	click(item("desk-new", false))
	if len(service.Snapshot().Conversations) != 1 {
		t.Fatal("disabled native action created a conversation")
	}
	nativeDropEval(t, win, `document.querySelector('[data-slot="dialog-close"]').click();return true;`)
	click(item("desk-new", true))
	deadline := time.Now().Add(5 * time.Second)
	for service.Snapshot().ActiveID == first.ID {
		if time.Now().After(deadline) {
			t.Fatal("installed New Conversation did not reach the service through the page")
		}
		time.Sleep(15 * time.Millisecond)
	}
	if state := service.Snapshot(); len(state.Conversations) != 2 || state.Conversations[0].WorkspaceID != workspace.ID {
		t.Fatalf("native action created the wrong conversation: %+v", state.Conversations)
	}
	click(item("desk-export", true))
	deadline = time.Now().Add(5 * time.Second)
	for {
		data, err := os.ReadFile(exported)
		if err == nil && strings.HasPrefix(string(data), "# New conversation") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("installed export did not save the conversation: %q %v", data, err)
		}
		time.Sleep(15 * time.Millisecond)
	}
	// Inspect the installed View menu, which routes these roles to the child WebView.
	var zoomIn, resetZoom *mygo.MenuItem
	for _, top := range menu.Items() {
		if top.Role != mygo.RoleViewMenu {
			continue
		}
		for _, entry := range top.Submenu {
			switch entry.Role {
			case mygo.RoleZoomIn:
				zoomIn = entry
			case mygo.RoleResetZoom:
				resetZoom = entry
			}
		}
	}
	if zoomIn == nil || resetZoom == nil || zoomIn.Click == nil || resetZoom.Click == nil {
		t.Fatal("installed View menu lost its page commands")
	}
	click(zoomIn)
	if win.Page().ZoomFactor() <= 1 {
		t.Fatal("native zoom command did not reach the main WebView")
	}
	click(resetZoom)
	if win.Page().ZoomFactor() != 1 {
		t.Fatal("native reset zoom did not reach the main WebView")
	}
}
