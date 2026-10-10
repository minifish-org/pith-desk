package main

import (
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/minifish-org/pith-desk/internal/desk"
)

type notificationFixtureService struct {
	mu        sync.Mutex
	events    chan string
	openError map[string]error
	remember  error
	openGate  <-chan struct{}
}

func (s *notificationFixtureService) RememberCompletionNotification(entry desk.Conversation, workspace desk.Workspace) (desk.CompletionNotification, []string, error) {
	s.events <- "remember"
	return desk.CompletionNotification{ID: "stable", ConversationID: entry.ID}, []string{"superseded"}, s.remember
}

func (s *notificationFixtureService) OpenCompletionNotification(id string) error {
	id = strings.TrimPrefix(id, "pith-desk:completion:")
	s.events <- "open " + id
	if s.openGate != nil {
		<-s.openGate
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.openError[id]
}

func (s *notificationFixtureService) ForgetCompletionNotification(id string) error {
	id = strings.TrimPrefix(id, "pith-desk:completion:")
	s.events <- "forget " + id
	return nil
}

func notificationControllerFixture(t *testing.T) (*desktopNotifications, *notificationFixtureService) {
	t.Helper()
	s := &notificationFixtureService{events: make(chan string, 64), openError: map[string]error{}}
	c := &desktopNotifications{actions: notificationActions{
		supported: func() bool { return true },
		show: func(desk.CompletionNotification, desk.Conversation, desk.Workspace) error {
			s.events <- "show"
			return nil
		},
		remove:   func(id string) { s.events <- "remove " + strings.TrimPrefix(id, "pith-desk:completion:") },
		activate: func() { s.events <- "activate" },
		explain:  func(message string) { s.events <- "explain " + message },
		onError:  func(err error) { s.events <- "error " + err.Error() },
	}}
	t.Cleanup(c.Close)
	return c, s
}

func notificationEvent(t *testing.T, events <-chan string, want string) {
	t.Helper()
	select {
	case got := <-events:
		if got != want {
			t.Fatalf("notification event = %q, want %q", got, want)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("missing notification event %q", want)
	}
}

func noNotificationEvent(t *testing.T, events <-chan string) {
	t.Helper()
	select {
	case event := <-events:
		t.Fatalf("unexpected notification event %q", event)
	default:
	}
}

func TestDesktopNotificationQueuesColdStartAndHandlesUnavailableTargets(t *testing.T) {
	c, s := notificationControllerFixture(t)
	s.openError["deleted"] = desk.ErrNotificationUnavailable
	c.click("pith-desk:completion:valid")
	c.click("pith-desk:completion:valid") // coalesce repeated callbacks before initialization
	c.click("pith-desk:completion:deleted")
	noNotificationEvent(t, s.events)
	c.setReady(s)
	for _, event := range []string{
		"open valid", "forget valid", "remove valid", "activate",
		"open deleted", "forget deleted", "remove deleted", "activate",
		"explain " + desk.ErrNotificationUnavailable.Error() + ".",
	} {
		notificationEvent(t, s.events, event)
	}
	c.Close()
	c.click("pith-desk:completion:after-close")
	noNotificationEvent(t, s.events)
}

func TestDesktopNotificationCloseDropsQueuedClicksAndDetachesListenerOnce(t *testing.T) {
	c, s := notificationControllerFixture(t)
	detached := 0
	c.off = func() { detached++ }
	c.click("pith-desk:completion:before-ready")
	c.Close()
	c.Close()
	c.setReady(s)
	c.click("pith-desk:completion:after-close")
	c.Show(desk.Conversation{}, desk.Workspace{})
	if detached != 1 {
		t.Fatalf("listener detached %d times", detached)
	}
	noNotificationEvent(t, s.events)
}

func TestDesktopNotificationIgnoresOtherNotificationNamespaces(t *testing.T) {
	c, s := notificationControllerFixture(t)
	c.setReady(s)
	for _, id := range []string{"", "mygo-old-random", "pith-desk:unrelated:session", "other-app:completion:session"} {
		c.click(id)
	}
	c.Close()
	noNotificationEvent(t, s.events)
}

func TestDesktopNotificationNativeGateDropsWorkQueuedBehindQuit(t *testing.T) {
	c, s := notificationControllerFixture(t)
	scheduled, complete := make(chan func(), 1), make(chan struct{})
	c.actions.schedule = func(fn func()) {
		scheduled <- fn
		<-complete
	}
	c.setReady(s)
	c.click("pith-desk:completion:late")
	notificationEvent(t, s.events, "open late")
	notificationEvent(t, s.events, "forget late")
	var native func()
	select {
	case native = <-scheduled:
	case <-time.After(3 * time.Second):
		t.Fatal("native activation was not scheduled")
	}
	c.Close()
	native() // represents execution during shutdown after OnWillQuit
	close(complete)
	noNotificationEvent(t, s.events)
}

func TestDesktopNotificationQuitCancelsOnlyInFlightShows(t *testing.T) {
	c, s := notificationControllerFixture(t)
	c.actions.schedule = func(fn func()) { fn() }
	c.setReady(s)
	// A completed Show has been handed to the OS and survives process exit.
	c.Show(desk.Conversation{ID: "session"}, desk.Workspace{})
	for _, event := range []string{"remember", "remove superseded", "show"} {
		notificationEvent(t, s.events, event)
	}
	entered, released, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	c.actions.show = func(desk.CompletionNotification, desk.Conversation, desk.Workspace) error {
		close(entered)
		<-released
		return nil
	}
	c.actions.remove = func(id string) {
		s.events <- "remove " + id
		if id == "stable" {
			close(released) // the SDK settles an outstanding permission request
		}
	}
	go func() { c.Show(desk.Conversation{ID: "session"}, desk.Workspace{}); close(done) }()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("show did not enter the permission wait")
	}
	c.Close()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("quit did not settle an outstanding notification")
	}
	for _, event := range []string{"remember", "remove superseded", "remove stable"} {
		notificationEvent(t, s.events, event)
	}
	noNotificationEvent(t, s.events)
}

func TestDesktopNotificationTransientOpenFailureRetainsTarget(t *testing.T) {
	c, s := notificationControllerFixture(t)
	s.openError["retry"] = errors.New("busy")
	c.setReady(s)
	c.click("pith-desk:completion:retry")
	for _, event := range []string{
		"open retry", "activate", "error busy",
		"explain The conversation could not be opened. Try again after the current operation finishes.",
	} {
		notificationEvent(t, s.events, event)
	}
	c.Close()
	noNotificationEvent(t, s.events)
}

func TestDesktopNotificationCloseWaitsForServiceOperation(t *testing.T) {
	c, s := notificationControllerFixture(t)
	gate := make(chan struct{})
	s.openGate = gate
	c.setReady(s)
	c.click("pith-desk:completion:in-flight")
	notificationEvent(t, s.events, "open in-flight")
	closed := make(chan struct{})
	go func() { c.Close(); close(closed) }()
	select {
	case <-closed:
		t.Fatal("Close returned with a service operation still in flight")
	default:
	}
	close(gate)
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("Close did not finish after the service operation")
	}
	// The operation may acknowledge and schedule native activation before
	// Close wins its lock. It must never start another service operation.
	for {
		select {
		case event := <-s.events:
			if event != "forget in-flight" && event != "remove in-flight" && event != "activate" {
				t.Fatalf("unexpected operation during Close: %s", event)
			}
		default:
			c.click("pith-desk:completion:after-close")
			noNotificationEvent(t, s.events)
			return
		}
	}
}

func TestDesktopNotificationPermissionWaitDoesNotHoldServiceOrController(t *testing.T) {
	c, s := notificationControllerFixture(t)
	entered, release, finished := make(chan struct{}), make(chan struct{}), make(chan struct{})
	c.actions.show = func(desk.CompletionNotification, desk.Conversation, desk.Workspace) error {
		close(entered)
		<-release
		return errors.New("permission denied")
	}
	c.setReady(s)
	go func() { c.Show(desk.Conversation{ID: "session"}, desk.Workspace{ID: "workspace"}); close(finished) }()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("notification did not reach its permission wait")
	}
	closed := make(chan struct{})
	go func() { c.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("OS permission wait held the controller lock")
	}
	close(release)
	select {
	case <-finished:
	case <-time.After(3 * time.Second):
		t.Fatal("show did not return after its permission response")
	}
	notificationEvent(t, s.events, "remember")
	notificationEvent(t, s.events, "remove superseded")
	noNotificationEvent(t, s.events) // no service access after Close
}

func TestDesktopNotificationDeniedPermissionForgetsUnshownTarget(t *testing.T) {
	c, s := notificationControllerFixture(t)
	c.actions.show = func(desk.CompletionNotification, desk.Conversation, desk.Workspace) error {
		s.events <- "show"
		return errors.New("permission denied")
	}
	c.setReady(s)
	c.Show(desk.Conversation{ID: "session"}, desk.Workspace{ID: "workspace"})
	for _, event := range []string{"remember", "remove superseded", "show", "remove stable", "forget stable", "error permission denied"} {
		notificationEvent(t, s.events, event)
	}
	noNotificationEvent(t, s.events)
}

func TestDesktopNotificationSaveFailureDoesNotShowUnresolvableNotification(t *testing.T) {
	c, s := notificationControllerFixture(t)
	s.remember = errors.New("disk unavailable")
	c.setReady(s)
	c.Show(desk.Conversation{}, desk.Workspace{})
	notificationEvent(t, s.events, "remember")
	notificationEvent(t, s.events, "error disk unavailable")
	noNotificationEvent(t, s.events)
}
