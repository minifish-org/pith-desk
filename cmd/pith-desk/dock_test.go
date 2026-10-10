package main

import (
	"testing"
	"time"
)

func TestApprovalDockUsesLatestValueOnMainThread(t *testing.T) {
	scheduled := make(chan func(), 4)
	var badges []string
	d := &approvalDock{schedule: func(fn func()) { scheduled <- fn }, setBadge: func(badge string) { badges = append(badges, badge) }}
	d.setPending(true)
	d.setPending(false)
	invokeDockUpdate(t, scheduled)
	if len(badges) != 1 || badges[0] != "" {
		t.Fatalf("queued stale approval reached the Dock: %v", badges)
	}
	d.setPending(true)
	invokeDockUpdate(t, scheduled)
	if len(badges) != 2 || badges[1] != "!" {
		t.Fatalf("pending approval did not reach the Dock: %v", badges)
	}
	d.setPending(false)
	invokeDockUpdate(t, scheduled)
	if len(badges) != 3 || badges[2] != "" {
		t.Fatalf("resolved approval left a badge: %v", badges)
	}
}

func TestApprovalDockQuitClearsAndDiscardsQueuedUpdates(t *testing.T) {
	scheduled := make(chan func(), 4)
	var badges []string
	d := &approvalDock{schedule: func(fn func()) { scheduled <- fn }, setBadge: func(badge string) { badges = append(badges, badge) }}
	d.setPending(true)
	d.close()
	invokeDockUpdate(t, scheduled)
	d.setPending(true)
	if len(badges) != 1 || badges[0] != "" {
		t.Fatalf("quit left or restored an approval badge: %v", badges)
	}
	select {
	case <-scheduled:
		t.Fatal("closed Dock scheduled another update")
	default:
	}
}

func invokeDockUpdate(t *testing.T, scheduled <-chan func()) {
	t.Helper()
	select {
	case fn := <-scheduled:
		fn()
	case <-time.After(time.Second):
		t.Fatal("Dock update was not scheduled")
	}
}
