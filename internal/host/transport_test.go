package host

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/minifish-org/pith-desk/internal/desk"
)

func TestCoalesceChanges(t *testing.T) {
	changes := make(chan struct{})
	ticks := make(chan time.Time)
	flushed := make(chan struct{}, 1)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		coalesceChanges(ctx, changes, ticks, func() time.Duration { return 0 }, func() { flushed <- struct{}{} })
	}()
	for range 80 {
		changes <- struct{}{}
	}
	ticks <- time.Now()
	select {
	case <-flushed:
	case <-time.After(time.Second):
		t.Fatal("a burst of changes did not produce a flush")
	}
	select {
	case <-flushed:
		t.Fatal("one burst produced more than one flush")
	default:
	}
	ticks <- time.Now()
	select {
	case <-flushed:
		t.Fatal("an empty tick produced a flush")
	case <-time.After(20 * time.Millisecond):
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("coalescer did not stop")
	}
}

func TestCoalesceChangesWaitsForInterval(t *testing.T) {
	changes := make(chan struct{})
	ticks := make(chan time.Time)
	flushed := make(chan struct{}, 1)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		coalesceChanges(ctx, changes, ticks, func() time.Duration { return time.Hour }, func() { flushed <- struct{}{} })
	}()
	changes <- struct{}{}
	ticks <- time.Now()
	select {
	case <-flushed:
		t.Fatal("flush ignored the minimum interval")
	case <-time.After(20 * time.Millisecond):
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("coalescer did not stop")
	}
}

func TestBroadcastDelayTracksTranscriptSize(t *testing.T) {
	for _, tc := range []struct {
		messages int
		want     time.Duration
	}{{0, 25 * time.Millisecond}, {499, 25 * time.Millisecond}, {500, 50 * time.Millisecond}, {999, 50 * time.Millisecond}, {1000, 75 * time.Millisecond}, {1999, 75 * time.Millisecond}, {2000, 100 * time.Millisecond}} {
		if got := broadcastDelay(tc.messages); got != tc.want {
			t.Errorf("broadcastDelay(%d) = %s, want %s", tc.messages, got, tc.want)
		}
	}
}

func TestSlowDeliveryDoesNotBlockOtherSocketClients(t *testing.T) {
	s := testServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var fast []*websocket.Conn
	for range 2 {
		conn, _, err := websocket.Dial(ctx, strings.Replace(s.URL, "http://", "ws://", 1)+"/api/socket", &websocket.DialOptions{Subprotocols: []string{"pith-desk", "bearer." + s.token}})
		if err != nil {
			t.Fatal(err)
		}
		defer conn.CloseNow()
		if _, _, err := conn.Read(ctx); err != nil {
			t.Fatal(err)
		}
		fast = append(fast, conn)
	}
	// Stall a registered delivery queue deterministically. Real socket writes
	// consume this queue outside the broadcaster lock; an OS send-buffer timing
	// test would depend on the machine's buffer sizes instead of our invariant.
	stalled := make(chan []byte, 1)
	stalled <- []byte(`{"stale":true}`)
	s.mu.Lock()
	s.clients[stalled] = struct{}{}
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.clients, stalled); s.mu.Unlock() }()
	for i := range 20 {
		mode := desk.AppearanceLight
		if i%2 == 1 {
			mode = desk.AppearanceSystem
		}
		if err := s.service.SetAppearance(mode); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.service.SetAppearance(desk.AppearanceDark); err != nil {
		t.Fatal(err)
	}
	for _, conn := range fast {
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				t.Fatal(err)
			}
			var state desk.State
			if err := json.Unmarshal(data, &state); err != nil {
				t.Fatal(err)
			}
			if state.Settings.Appearance == desk.AppearanceDark {
				break
			}
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	select {
	case data := <-stalled:
		var state desk.State
		if err := json.Unmarshal(data, &state); err != nil || state.Settings.Appearance != desk.AppearanceDark {
			t.Fatalf("stalled queue did not converge to latest state: %s, %v", data, err)
		}
	default:
		t.Fatal("stalled queue lost its latest snapshot")
	}
}
