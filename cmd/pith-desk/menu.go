package main

import (
	"context"
	"log"
	"runtime"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/minifish-org/pith-desk/internal/desk"
	"github.com/minifish-org/pith-desk/internal/host"
)

type nativeMenuAvailability struct {
	NewConversation bool
	ChooseWorkspace bool
	Export          bool
	Settings        bool
}

func nativeMenuPolicy(state desk.State, input host.NativeMenuStateInput) nativeMenuAvailability {
	if !input.Ready || input.Busy || input.Modal || state.Login != nil {
		return nativeMenuAvailability{}
	}
	available := nativeMenuAvailability{NewConversation: true, ChooseWorkspace: true, Settings: true}
	// A service-driven selection (including a notification click) may reach the
	// native observer before the page. Wait for both to name the same session.
	if input.ActiveID == "" || input.ActiveID != state.ActiveID {
		return available
	}
	for _, entry := range state.Conversations {
		if entry.ID == input.ActiveID && entry.WorkspaceID == input.WorkspaceID {
			for _, run := range state.Runs {
				if run.ConversationID == entry.ID {
					return available
				}
			}
			available.Export = true
			break
		}
	}
	return available
}

func (a nativeMenuAvailability) permits(action string) bool {
	switch action {
	case "new-conversation":
		return a.NewConversation
	case "choose-workspace":
		return a.ChooseWorkspace
	case "export-conversation":
		return a.Export
	case "settings":
		return a.Settings
	}
	return false
}

func installNativeMenu(server *host.Server, window *mygo.Window) *nativeMenuController {
	controller := &nativeMenuController{schedule: mygo.RunOnMain}
	dispatch := func(action string) {
		if !controller.permits(action) {
			return
		}
		// Menu callbacks run on the UI thread; evaluating a page can wait for a
		// result. The page performs its own current-state check before acting.
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if _, err := window.Page().EvalContext(ctx, nativeMenuScript(action)); err != nil {
				log.Printf("Pith Desk menu: %v", err)
			}
		}()
	}
	menu := mygo.NewMenu(nativeMenuTemplate(dispatch))
	controller.applyNative = func(available nativeMenuAvailability) {
		menu.ItemByID("desk-new").SetEnabled(available.NewConversation)
		menu.ItemByID("desk-workspace").SetEnabled(available.ChooseWorkspace)
		menu.ItemByID("desk-export").SetEnabled(available.Export)
		menu.ItemByID("desk-settings").SetEnabled(available.Settings)
	}
	mygo.App.SetMenu(menu)
	server.SetNativeMenuAction(controller.setState)
	window.Page().OnDidNavigate(func(string) {
		_ = server.SetNativeMenuState(host.NativeMenuStateInput{})
	})
	mygo.App.OnWillQuit(func(_ *mygo.QuitEvent) {
		server.SetNativeMenuAction(nil)
		controller.close()
	})
	return controller
}

func nativeMenuTemplate(dispatch func(string)) []*mygo.MenuItem {
	item := func(id, label, shortcut, action string) *mygo.MenuItem {
		return &mygo.MenuItem{ID: id, Label: label, Accelerator: shortcut, Disabled: true, Click: func(*mygo.MenuItem, *mygo.Window) { dispatch(action) }}
	}
	settings := item("desk-settings", "Settings…", "CmdOrCtrl+,", "settings")
	file := []*mygo.MenuItem{
		item("desk-new", "New Conversation", "CmdOrCtrl+N", "new-conversation"),
		item("desk-workspace", "Choose Workspace…", "CmdOrCtrl+O", "choose-workspace"),
		mygo.Separator(),
		item("desk-export", "Export Current Conversation…", "CmdOrCtrl+Shift+E", "export-conversation"),
		mygo.Separator(),
	}
	app := &mygo.MenuItem{Role: mygo.RoleAppMenu}
	if runtime.GOOS == "darwin" {
		app.Submenu = []*mygo.MenuItem{
			{Role: mygo.RoleAbout}, mygo.Separator(), settings, mygo.Separator(),
			{Role: mygo.RoleServices}, mygo.Separator(),
			{Role: mygo.RoleHide}, {Role: mygo.RoleHideOthers}, {Role: mygo.RoleUnhide},
			mygo.Separator(), {Role: mygo.RoleQuit},
		}
		file = append(file, &mygo.MenuItem{Role: mygo.RoleClose})
	} else {
		file = append(file, settings, mygo.Separator(), &mygo.MenuItem{Role: mygo.RoleQuit})
	}
	return []*mygo.MenuItem{
		app,
		{Role: mygo.RoleFileMenu, Submenu: file},
		{Role: mygo.RoleEditMenu},
		{Role: mygo.RoleViewMenu},
		{Role: mygo.RoleWindowMenu},
	}
}

// Only fixed action names enter the page; no page-controlled code is evaluated.
func nativeMenuScript(action string) string {
	switch action {
	case "new-conversation", "choose-workspace", "export-conversation", "settings":
		return "window.dispatchEvent(new CustomEvent('pith:native-menu', {detail: {action: '" + action + "'}}))"
	}
	return "false"
}

// Updates are coalesced before scheduling native work. A menu opening or native
// dialog must never block the HTTP handlers or the state broadcaster.
type nativeMenuController struct {
	mu          sync.Mutex
	available   nativeMenuAvailability
	known       bool
	scheduled   bool
	closed      bool
	schedule    func(func())
	applyNative func(nativeMenuAvailability)
}

func (c *nativeMenuController) setState(state desk.State, input host.NativeMenuStateInput) {
	c.setAvailability(nativeMenuPolicy(state, input))
}

func (c *nativeMenuController) setAvailability(available nativeMenuAvailability) {
	c.mu.Lock()
	if c.closed || (c.known && c.available == available) {
		c.mu.Unlock()
		return
	}
	c.available = available
	c.known = true
	if c.scheduled {
		c.mu.Unlock()
		return
	}
	c.scheduled = true
	c.mu.Unlock()
	go c.schedule(c.apply)
}

func (c *nativeMenuController) apply() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.scheduled = false
	if !c.closed {
		c.applyNative(c.available)
	}
}

func (c *nativeMenuController) permits(action string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return !c.closed && c.available.permits(action)
}

func (c *nativeMenuController) close() {
	c.mu.Lock()
	c.closed = true
	c.available = nativeMenuAvailability{}
	c.mu.Unlock()
	c.applyNative(nativeMenuAvailability{})
}
