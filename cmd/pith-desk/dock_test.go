package main

import (
	"testing"
	"time"

	"github.com/minifish-org/pith-desk/internal/host"
)

func TestTaskDockUsesLatestValueOnMainThread(t *testing.T) {
	scheduled := make(chan func(), 4)
	var badges []string
	d := &taskDock{schedule: func(fn func()) { scheduled <- fn }, setBadge: func(badge string) { badges = append(badges, badge) }}
	d.setStatus(host.TaskStatus{NeedsApproval: true})
	d.setStatus(host.TaskStatus{Unread: 2})
	invokeDockUpdate(t, scheduled)
	if len(badges) != 1 || badges[0] != "2" {
		t.Fatalf("queued stale approval reached the Dock: %v", badges)
	}
	d.setStatus(host.TaskStatus{NeedsApproval: true})
	invokeDockUpdate(t, scheduled)
	if len(badges) != 2 || badges[1] != "!" {
		t.Fatalf("pending approval did not reach the Dock: %v", badges)
	}
	d.setStatus(host.TaskStatus{Running: 1})
	invokeDockUpdate(t, scheduled)
	if len(badges) != 3 || badges[2] != "…" {
		t.Fatalf("resolved approval did not restore running status: %v", badges)
	}
}

func TestTaskDockQuitClearsAndDiscardsQueuedUpdates(t *testing.T) {
	scheduled := make(chan func(), 4)
	var badges []string
	d := &taskDock{schedule: func(fn func()) { scheduled <- fn }, setBadge: func(badge string) { badges = append(badges, badge) }}
	d.setStatus(host.TaskStatus{Unread: 2})
	d.close()
	invokeDockUpdate(t, scheduled)
	d.setStatus(host.TaskStatus{Running: 1})
	if len(badges) != 1 || badges[0] != "" {
		t.Fatalf("quit left or restored an approval badge: %v", badges)
	}
	select {
	case <-scheduled:
		t.Fatal("closed Dock scheduled another update")
	default:
	}
}

func TestDockBadgePriorityAndUnreadCount(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status host.TaskStatus
		badge  string
	}{
		{"idle", host.TaskStatus{}, ""},
		{"running", host.TaskStatus{Running: 2}, "…"},
		{"completed unread", host.TaskStatus{Unread: 1}, "1"},
		{"unread before running", host.TaskStatus{Running: 2, Unread: 3}, "3"},
		{"approval before unread", host.TaskStatus{Running: 2, NeedsApproval: true, Unread: 3}, "!"},
		{"large unread count", host.TaskStatus{Unread: 100}, "99+"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if badge := dockBadge(tc.status); badge != tc.badge {
				t.Fatalf("Dock badge = %q, want %q", badge, tc.badge)
			}
		})
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
