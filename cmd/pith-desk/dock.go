package main

import (
	"runtime"
	"strconv"
	"sync"

	"github.com/egoist/mygo"
	"github.com/minifish-org/pith-desk/internal/host"
)

// installDockTaskStatus is called once the desktop app is ready. Dock badges
// are a macOS feature; other platforms retain the in-app task indicators.
func installDockTaskStatus(server *host.Server) *taskDock {
	if runtime.GOOS != "darwin" {
		return nil
	}
	status := &taskDock{schedule: mygo.RunOnMain, setBadge: mygo.App.Dock.SetBadge}
	server.SetTaskStatusAction(status.setStatus)
	mygo.App.OnWillQuit(func(_ *mygo.QuitEvent) {
		server.SetTaskStatusAction(nil)
		status.close()
	})
	return status
}

// taskDock coalesces state before native UI work. Only one main-thread
// update is scheduled at a time, and it reads the latest value when executed.
// schedule must run its callback on the native UI thread; close runs there too.
type taskDock struct {
	mu        sync.Mutex
	badge     string
	scheduled bool
	closed    bool
	schedule  func(func())
	setBadge  func(string)
}

// Only pending approval and unread completion need attention in the Dock.
// Approval takes priority; unread results outlive their temporary banners.
func dockBadge(status host.TaskStatus) string {
	switch {
	case status.NeedsApproval:
		return "!"
	case status.Unread > 99:
		return "99+"
	case status.Unread > 0:
		return strconv.Itoa(status.Unread)
	default:
		return ""
	}
}

func (d *taskDock) setStatus(status host.TaskStatus) {
	d.mu.Lock()
	if d.closed {
		d.mu.Unlock()
		return
	}
	d.badge = dockBadge(status)
	if d.scheduled {
		d.mu.Unlock()
		return
	}
	d.scheduled = true
	d.mu.Unlock()
	// MyGo's main-thread dispatch waits for completion. Keep that wait outside
	// the host broadcaster so native dialogs cannot hold up frontend state.
	go d.schedule(d.apply)
}

func (d *taskDock) apply() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.scheduled = false
	if d.closed {
		return
	}
	d.setBadge(d.badge)
}

func (d *taskDock) close() {
	d.mu.Lock()
	d.closed = true
	d.badge = ""
	d.mu.Unlock()
	d.setBadge("")
}
