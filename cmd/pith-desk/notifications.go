package main

import (
	"errors"
	"log"
	"slices"
	"strings"
	"sync"

	"github.com/egoist/mygo"
	"github.com/minifish-org/pith-desk/internal/desk"
)

type notificationService interface {
	RememberCompletionNotification(desk.Conversation, desk.Workspace) (desk.CompletionNotification, []string, error)
	OpenCompletionNotification(string) error
	ForgetCompletionNotification(string) error
}

type notificationActions struct {
	schedule  func(func())
	supported func() bool
	show      func(desk.CompletionNotification, desk.Conversation, desk.Workspace) error
	remove    func(string)
	activate  func()
	explain   func(string)
	onError   func(error)
}

// desktopNotifications lives only with the application process. The OS owns
// delivered notifications; the local service owns their persisted targets.
type desktopNotifications struct {
	mu       sync.Mutex
	service  notificationService
	actions  notificationActions
	off      func()
	offQuit  func()
	pending  []string
	inFlight map[string]bool
	ready    bool
	draining bool
	closed   bool
}

// Register before App.Run: macOS delivers the click that launched the app
// before the service and main window have been created.
func newDesktopNotifications() *desktopNotifications {
	c := &desktopNotifications{actions: notificationActions{
		schedule:  mygo.RunOnMain,
		supported: mygo.NotificationsSupported,
		show: func(target desk.CompletionNotification, entry desk.Conversation, workspace desk.Workspace) error {
			return mygo.NewNotification(mygo.NotificationOptions{
				ID: target.ID, Group: "pith-desk:conversation:" + target.ConversationID,
				Title: "Task completed", Body: workspace.Name + " · " + entry.Title, Silent: true,
			}).Show()
		},
		remove:  func(id string) { mygo.NewNotification(mygo.NotificationOptions{ID: id}).Close() },
		onError: func(err error) { log.Printf("Task notification: %v", err) },
	}}
	c.off = mygo.App.OnNotificationClick(c.click)
	c.offQuit = mygo.App.OnWillQuit(func(_ *mygo.QuitEvent) { c.Close() })
	return c
}

func (c *desktopNotifications) Ready(service *desk.Service, window *mygo.Window, dialogMu *sync.Mutex) {
	c.mu.Lock()
	c.actions.activate = func() {
		if window.IsDestroyed() {
			return
		}
		window.Restore()
		window.Show()
		window.Focus()
	}
	c.actions.explain = func(message string) {
		// The shared dialog mutex is acquired off the main thread. An existing
		// sheet must be able to process native events and release this lock.
		dialogMu.Lock()
		defer dialogMu.Unlock()
		c.native(func() {
			if window.IsDestroyed() {
				return
			}
			_, err := mygo.Dialog.Message(mygo.MessageOptions{
				Parent: window, Type: mygo.MessageInfo, Title: "Task notification",
				Message: message, Buttons: []string{"OK"}, DefaultButton: 0, CancelButton: 0,
			})
			if err != nil {
				c.actions.onError(err)
			}
		})
	}
	c.mu.Unlock()
	c.setReady(service)
}

func (c *desktopNotifications) setReady(service notificationService) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	c.service, c.ready = service, true
	c.startDrainLocked()
}

func (c *desktopNotifications) click(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || !strings.HasPrefix(id, "pith-desk:completion:") || slices.Contains(c.pending, id) {
		return
	}
	c.pending = append(c.pending, id)
	if len(c.pending) > 32 {
		c.pending = c.pending[len(c.pending)-32:]
	}
	c.startDrainLocked()
}

func (c *desktopNotifications) startDrainLocked() {
	if c.ready && !c.draining && len(c.pending) != 0 {
		c.draining = true
		go c.drain()
	}
}

func (c *desktopNotifications) drain() {
	for {
		c.mu.Lock()
		if c.closed || !c.ready || len(c.pending) == 0 {
			c.draining = false
			c.mu.Unlock()
			return
		}
		id := c.pending[0]
		c.pending = c.pending[1:]
		// Close cannot return while a service operation is in flight, and no
		// service operation begins after Close. Native work stays outside the
		// controller lock because a dialog can wait for a user decision.
		err := c.service.OpenCompletionNotification(id)
		remove := err == nil || errors.Is(err, desk.ErrNotificationUnavailable)
		if remove {
			if forgetErr := c.service.ForgetCompletionNotification(id); forgetErr != nil {
				c.actions.onError(forgetErr)
			}
		}
		actions := c.actions
		c.mu.Unlock()
		if !c.native(func() {
			if remove {
				actions.remove(id)
			}
			actions.activate()
		}) {
			return
		}
		if errors.Is(err, desk.ErrNotificationUnavailable) {
			actions.explain(desk.ErrNotificationUnavailable.Error() + ".")
		} else if err != nil {
			actions.onError(err)
			actions.explain("The conversation could not be opened. Try again after the current operation finishes.")
		}
	}
}

func (c *desktopNotifications) Show(entry desk.Conversation, workspace desk.Workspace) {
	c.mu.Lock()
	if c.closed || !c.ready {
		c.mu.Unlock()
		return
	}
	actions := c.actions
	c.mu.Unlock()
	supported := false
	if !c.native(func() { supported = actions.supported() }) || !supported {
		return
	}
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	target, removed, err := c.service.RememberCompletionNotification(entry, workspace)
	c.mu.Unlock()
	if err != nil {
		actions.onError(err)
		return
	}
	// Show may wait for the first OS permission response. Neither the
	// service nor controller lock is held while it does so.
	var showErr error
	if !c.native(func() {
		for _, id := range removed {
			actions.remove(id)
		}
		c.mu.Lock()
		if c.inFlight == nil {
			c.inFlight = make(map[string]bool)
		}
		c.inFlight[target.ID] = true
		c.mu.Unlock()
		showErr = actions.show(target, entry, workspace)
		c.mu.Lock()
		delete(c.inFlight, target.ID)
		c.mu.Unlock()
	}) {
		return
	}
	if showErr != nil {
		if c.isClosed() {
			return
		}
		c.native(func() { actions.remove(target.ID) })
		c.mu.Lock()
		if !c.closed {
			if forgetErr := c.service.ForgetCompletionNotification(target.ID); forgetErr != nil {
				actions.onError(forgetErr)
			}
		}
		c.mu.Unlock()
		actions.onError(showErr)
	}
}

// Native calls are gated when their main-thread callback actually executes,
// including work queued behind a final quit. RunOnMain drops later posts after
// shutdown. No controller lock spans a native permission wait or message sheet.
func (c *desktopNotifications) native(fn func()) bool {
	c.mu.Lock()
	schedule := c.actions.schedule
	c.mu.Unlock()
	if schedule == nil {
		schedule = func(fn func()) { fn() }
	}
	executed := false
	schedule(func() {
		if c.isClosed() {
			return
		}
		executed = true
		fn()
	})
	return executed
}

func (c *desktopNotifications) isClosed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed
}

// Close drops pending clicks and detaches the native listener before the
// service closes. Valid delivered entries remain with the OS for next launch.
func (c *desktopNotifications) Close() {
	c.mu.Lock()
	c.closed = true
	c.pending, c.service = nil, nil
	off := c.off
	offQuit := c.offQuit
	var inFlight []string
	for id := range c.inFlight {
		inFlight = append(inFlight, id)
	}
	actions := c.actions
	c.off = nil
	c.offQuit = nil
	c.inFlight = nil
	c.mu.Unlock()
	if off != nil {
		off()
	}
	if offQuit != nil {
		offQuit()
	}
	// At OnWillQuit this runs on the main thread. Removing only outstanding
	// Show requests releases an unresolved permission wait without waiting
	// for the user's answer; previously delivered valid notifications survive.
	if actions.schedule != nil && len(inFlight) != 0 {
		actions.schedule(func() {
			for _, id := range inFlight {
				actions.remove(id)
			}
		})
	}
}
