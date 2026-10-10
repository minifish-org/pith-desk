package main

import (
	"errors"
	"testing"
)

func TestQuitConfirmationIdleSkipsDialog(t *testing.T) {
	quits := 0
	c := &quitConfirmation{
		active: func() bool { return false },
		confirm: func() (bool, error) {
			t.Fatal("idle exit displayed a confirmation")
			return false, nil
		},
		quit: func() { quits++ },
	}
	if prevent, start := c.request(); !prevent || !start {
		t.Fatal("initial event did not schedule its exit decision")
	}
	c.resolve()
	if quits != 1 {
		t.Fatalf("idle exit requested quit %d times", quits)
	}
	assertAuthorizedQuit(t, c)
}

func TestQuitConfirmationCoalescesCloseAndQuit(t *testing.T) {
	confirmations, quits := 0, 0
	c := &quitConfirmation{
		active: func() bool { return true },
		confirm: func() (bool, error) {
			confirmations++
			return true, nil
		},
		quit: func() { quits++ },
	}
	if prevent, start := c.request(); !prevent || !start {
		t.Fatal("close event did not schedule confirmation")
	}
	if prevent, start := c.request(); !prevent || start {
		t.Fatal("concurrent quit was not coalesced with close")
	}
	c.resolve()
	assertAuthorizedQuit(t, c)
	if confirmations != 1 || quits != 1 {
		t.Fatalf("got %d confirmations and %d quits", confirmations, quits)
	}
	c.finish()
	if prevent, start := c.request(); !prevent || !start {
		t.Fatal("authorization survived its quit sequence")
	}
}

func TestQuitConfirmationCancelAndErrorAllowRetry(t *testing.T) {
	for _, test := range []struct {
		name      string
		confirmed bool
		err       error
	}{
		{name: "keep working"},
		{name: "dialog error", confirmed: true, err: errors.New("dialog failed")},
	} {
		t.Run(test.name, func(t *testing.T) {
			quits, reportedErrors := 0, 0
			c := &quitConfirmation{
				active:  func() bool { return true },
				confirm: func() (bool, error) { return test.confirmed, test.err },
				quit:    func() { quits++ },
				onError: func(error) { reportedErrors++ },
			}
			c.request()
			c.resolve()
			if quits != 0 {
				t.Fatal("canceled or failed confirmation quit the app")
			}
			if (reportedErrors != 0) != (test.err != nil) {
				t.Fatal("dialog error was not reported correctly")
			}
			if prevent, start := c.request(); !prevent || !start {
				t.Fatal("could not retry after canceled or failed confirmation")
			}
		})
	}
}

func TestQuitConfirmationWorkFinishesDuringDialog(t *testing.T) {
	active := true
	confirmations, quits := 0, 0
	c := &quitConfirmation{
		active: func() bool { return active },
		confirm: func() (bool, error) {
			confirmations++
			active = false
			return false, nil // Keep working must still be honored.
		},
		quit: func() { quits++ },
	}
	c.request()
	c.resolve()
	if quits != 0 {
		t.Fatal("task completion overrode the user's keep-working decision")
	}
	c.request()
	c.resolve()
	if confirmations != 1 || quits != 1 {
		t.Fatalf("subsequent idle close got %d confirmations and %d quits", confirmations, quits)
	}
}

func TestQuitConfirmationWorkFinishesBeforeDecision(t *testing.T) {
	active := true
	quits := 0
	c := &quitConfirmation{
		active: func() bool { return active },
		confirm: func() (bool, error) {
			t.Fatal("completed work displayed a confirmation")
			return false, nil
		},
		quit: func() { quits++ },
	}
	c.request()
	active = false
	c.resolve()
	if quits != 1 {
		t.Fatal("completed work did not exit")
	}
}

func TestQuitConfirmationWaitsForDraftsAndRetriesFailedSave(t *testing.T) {
	quits, saves, reportedErrors := 0, 0, 0
	fail := true
	var c *quitConfirmation
	c = &quitConfirmation{
		active: func() bool { return false },
		beforeQuit: func() error {
			saves++
			if prevent, start := c.request(); !prevent || start {
				t.Fatal("a second exit did not wait for the pending save")
			}
			if fail {
				return errors.New("disk unavailable")
			}
			return nil
		},
		quit: func() {
			if saves != 2 {
				t.Fatal("quit happened before the successful save")
			}
			quits++
		},
		onError: func(error) { reportedErrors++ },
	}
	c.request()
	c.resolve()
	if quits != 0 || reportedErrors != 1 {
		t.Fatal("failed save did not keep the app open and report its error")
	}
	fail = false
	if prevent, start := c.request(); !prevent || !start {
		t.Fatal("failed save prevented another exit attempt")
	}
	c.resolve()
	if quits != 1 {
		t.Fatal("successful save did not allow exit")
	}
	assertAuthorizedQuit(t, c)
}

func assertAuthorizedQuit(t *testing.T, c *quitConfirmation) {
	t.Helper()
	// MyGo delivers before-quit, followed by the main window's close event.
	for _, event := range []string{"before quit", "window close"} {
		if prevent, start := c.request(); prevent || start {
			t.Fatalf("authorized %s caused another confirmation", event)
		}
	}
}
