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
