package main

import (
	"runtime"
	"sync"

	"github.com/egoist/mygo"
	"github.com/minifish-org/pith-desk/internal/host"
)

// installDockApprovalStatus is called once the desktop app is ready. Dock
// badges are a macOS feature; other platforms keep their usual in-app approval
// controls and need no native handler.
func installDockApprovalStatus(server *host.Server) *approvalDock {
	if runtime.GOOS != "darwin" {
		return nil
	}
	status := &approvalDock{schedule: mygo.RunOnMain, setBadge: mygo.App.Dock.SetBadge}
	server.SetApprovalAction(status.setPending)
	mygo.App.OnWillQuit(func(_ *mygo.QuitEvent) {
		server.SetApprovalAction(nil)
		status.close()
	})
	return status
}

// approvalDock coalesces state before native UI work. Only one main-thread
// update is scheduled at a time, and it reads the latest value when executed.
// schedule must run its callback on the native UI thread; close runs there too.
type approvalDock struct {
	mu        sync.Mutex
	pending   bool
	scheduled bool
	closed    bool
	schedule  func(func())
	setBadge  func(string)
}

func (d *approvalDock) setPending(pending bool) {
	d.mu.Lock()
	if d.closed {
		d.mu.Unlock()
		return
	}
	d.pending = pending
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

func (d *approvalDock) apply() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.scheduled = false
	if d.closed {
		return
	}
	badge := ""
	if d.pending {
		badge = "!"
	}
	d.setBadge(badge)
}

func (d *approvalDock) close() {
	d.mu.Lock()
	d.closed = true
	d.pending = false
	d.mu.Unlock()
	d.setBadge("")
}
