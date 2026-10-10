package main

import (
	"context"
	"errors"
	"log"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/minifish-org/pith-desk/internal/desk"
)

// installQuitConfirmation keeps a close or quit from interrupting work without
// an explicit decision. Closing an idle window still quits the application.
func installQuitConfirmation(service *desk.Service, window *mygo.Window, dialogMu *sync.Mutex) {
	active := func() bool { return len(service.Snapshot().Runs) != 0 }
	controller := &quitConfirmation{
		active: active,
		confirm: func() (bool, error) {
			dialogMu.Lock()
			defer dialogMu.Unlock()
			// Work may finish while another native dialog is being dismissed.
			if !active() {
				return true, nil
			}
			result, err := mygo.Dialog.Message(mygo.MessageOptions{
				Parent: window, Type: mygo.MessageWarning, Title: "Quit Pith Desk?",
				Message:       "Tasks are still running.",
				Detail:        "Quitting will interrupt tasks in all workspaces, including tasks waiting for approval. Completed changes will remain in place.",
				Buttons:       []string{"Keep working", "Stop tasks and quit"},
				DefaultButton: 0, CancelButton: 0,
			})
			return result.Button == 1, err
		},
		beforeQuit: func() error { return flushDesktopDrafts(window) },
		quit:       mygo.App.Quit,
		onError: func(err error) {
			log.Printf("Prepare application exit: %v", err)
		},
	}
	intercept := func(e interface{ PreventDefault() }) {
		prevent, start := controller.request()
		if prevent {
			e.PreventDefault()
		}
		if start {
			// Snapshot and the blocking dialog stay off the native UI thread.
			go controller.resolve()
		}
	}
	window.OnClose(func(e *mygo.CloseEvent) { intercept(e) })
	mygo.App.OnBeforeQuit(func(e *mygo.QuitEvent) { intercept(e) })
	mygo.App.OnWillQuit(func(_ *mygo.QuitEvent) { controller.finish() })
}

func flushDesktopDrafts(window *mygo.Window) error {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	value, err := window.Page().EvalContext(ctx, `new Promise(resolve => {
  const event = new CustomEvent('pith:flush-drafts', { cancelable: true, detail: resolve });
  if (window.dispatchEvent(event)) resolve(true);
})`)
	if err != nil {
		return err
	}
	if value != true {
		return errors.New("Draft could not be saved before exit")
	}
	return nil
}

// quitConfirmation coalesces requests while the dialog is open. Authorization
// lasts for one quit sequence so its before-quit and window-close hooks agree.
type quitConfirmation struct {
	mu         sync.Mutex
	pending    bool
	authorized bool
	active     func() bool
	confirm    func() (bool, error)
	beforeQuit func() error
	quit       func()
	onError    func(error)
}

// request returns whether to prevent this event and start one async decision.
func (c *quitConfirmation) request() (prevent, start bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.authorized {
		return false, false
	}
	if c.pending {
		return true, false
	}
	c.pending = true
	return true, true
}

func (c *quitConfirmation) resolve() {
	confirmed := true
	var err error
	if c.active() {
		confirmed, err = c.confirm()
	}
	if confirmed && err == nil && c.beforeQuit != nil {
		err = c.beforeQuit()
	}
	c.mu.Lock()
	c.pending = false
	c.authorized = confirmed && err == nil
	quit := c.authorized
	c.mu.Unlock()
	if err != nil && c.onError != nil {
		c.onError(err)
	}
	if quit {
		c.quit()
	}
}

func (c *quitConfirmation) finish() {
	c.mu.Lock()
	c.authorized = false
	c.mu.Unlock()
}
