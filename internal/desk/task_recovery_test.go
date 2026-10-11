package desk

import (
	"context"
	"encoding/json"
	"errors"
	"image/color"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/minifish-org/pith-desk/internal/testsupport/filefault"
	"github.com/minifish-org/pith/packages/durable"
	"github.com/minifish-org/pith/packages/durable/storage/jsonl"
)

// Exercise the live error -> Continue handoff, including uncertain writes that
// did and did not reach disk. The old task really calls an external MCP tool;
// recovery must only read its journal, never resume that execution.
func TestInProcessContinuePreservesDurablePendingInput(t *testing.T) {
	for _, window := range []struct {
		name          string
		afterCommit   bool
		blockRecovery bool
	}{
		{name: "delivered-not-committed"},
		{name: "delivered-committed", afterCommit: true},
		{name: "recovery-read-fails", blockRecovery: true},
	} {
		t.Run(window.name, func(t *testing.T) {
			connector := newDeskMCPFixture(t, "", nil)
			requests := make(chan map[string]any, 16)
			firstRelease, continueRelease := make(chan struct{}), make(chan struct{})
			var firstOnce, continueOnce sync.Once
			defer firstOnce.Do(func() { close(firstRelease) })
			defer continueOnce.Do(func() { close(continueRelease) })
			var calls atomic.Int64
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
					return
				}
				n := calls.Add(1)
				requests <- body
				if n == 4 {
					http.Error(w, `{"error":{"message":"stop the uncertain turn"}}`, http.StatusBadRequest)
					return
				}
				startSSE(w)
				w.(http.Flusher).Flush()
				if n == 1 || n == 5 {
					release := firstRelease
					if n == 5 {
						release = continueRelease
					}
					select {
					case <-release:
					case <-r.Context().Done():
						return
					}
				}
				if n <= 2 {
					name, id, args := "tool_search", "recover-search", `{"query":"echo"}`
					if n == 2 {
						name, id, args = "mcp__office__echo", "recover-external-effect", `{"text":"one external operation"}`
					}
					sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"index": 0, "id": id, "type": "function", "function": map[string]any{"name": name, "arguments": args}}}}}}})
					finishSSE(w, "tool_calls")
					return
				}
				sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": "fixture reply"}}}})
				finishSSE(w, "stop")
			}))
			t.Cleanup(provider.Close)
			s, _, _ := configuredService(t, provider.URL)
			if err := s.SaveMCP(MCPInput{Name: "office", Type: "http", URL: connector.server.URL, Enabled: true}); err != nil {
				t.Fatal(err)
			}
			id := s.Snapshot().ActiveID
			if err := s.SetPermissionMode(id, PermissionFullAccess); err != nil {
				t.Fatal(err)
			}
			var reject, readBlocked atomic.Bool
			reject.Store(true)
			s.journals.open = func(path string) (durable.Storage, error) {
				if readBlocked.Load() {
					return nil, filefault.ErrInjected
				}
				base, err := jsonl.Open(context.Background(), path, jsonl.Options{Fsync: true})
				if err != nil {
					return nil, err
				}
				probe := &journalWindow{Storage: base}
				inject := func(_ context.Context, writes []durable.StorageWrite) error {
					if reject.Load() && journalHasKind(writes, "desk.delivered") {
						readBlocked.Store(window.blockRecovery)
						return filefault.ErrInjected
					}
					return nil
				}
				if window.afterCommit {
					probe.after = inject
				} else {
					probe.before = inject
				}
				return probe, nil
			}
			if err := s.Send("perform the original external operation"); err != nil {
				t.Fatal(err)
			}
			receiveProviderRequest(t, requests)
			for index, text := range []string{"uncertain first", "undelivered second", "undelivered third"} {
				image := imageFixture(t, color.RGBA{R: uint8(index * 80), B: uint8(255 - index*80), A: 255})
				if err := s.QueueMessage(id, text, QueueFollowUp, image); err != nil {
					t.Fatal(err)
				}
			}
			pending := s.Snapshot().QueuedMessages
			if window.afterCommit {
				pending = pending[1:]
			}
			firstOnce.Do(func() { close(firstRelease) })
			receiveProviderRequest(t, requests) // External call after tool search.
			receiveProviderRequest(t, requests) // Reply after the external operation.
			uncertain := receiveProviderRequest(t, requests)
			if countProviderUser(uncertain, "uncertain first") != 1 || countProviderUser(uncertain, "undelivered second") != 0 || countProviderUser(uncertain, "undelivered third") != 0 {
				t.Fatal("fault window did not leave the remainder undelivered")
			}
			failed := waitState(t, s, func(st State) bool { return !st.Running })
			if !strings.Contains(failed.Error, "injected") || failed.Runtime.Phase != "error" || failed.Failure == nil || !failed.Failure.CanContinue || connector.calls.Load() != 1 || calls.Load() != 4 {
				t.Fatalf("journal failure was not settled without replay: %+v", failed)
			}
			if window.blockRecovery {
				if err := s.ContinueTask(id); !errors.Is(err, filefault.ErrInjected) {
					t.Fatalf("unreadable recovery allowed admission: %v", err)
				}
				state := s.Snapshot()
				if state.Running || state.Runtime.RunID != failed.Runtime.RunID || calls.Load() != 4 || connector.calls.Load() != 1 {
					t.Fatal("failed recovery changed task identity or replayed an operation")
				}
			}
			reject.Store(false)
			readBlocked.Store(false)
			if err := s.ContinueTask(id); err != nil {
				t.Fatal(err)
			}
			reviewed := receiveProviderRequest(t, requests)
			state := s.Snapshot()
			if state.Runtime.RunID == failed.Runtime.RunID || len(state.QueuedMessages) != len(pending) {
				t.Fatalf("live Continue lost durable input: want %d pending, got %d", len(pending), len(state.QueuedMessages))
			}
			for index, message := range state.QueuedMessages {
				want := pending[index]
				if message.ID == want.ID || message.Text != want.Text || message.Mode != want.Mode || message.ImageCount != want.ImageCount || !reflect.DeepEqual(message.Images, want.Images) {
					t.Fatalf("Continue changed pending text, attachment or order at %d", index)
				}
			}
			raw, _ := json.Marshal(reviewed)
			if !strings.Contains(string(raw), "Successful actions may already have taken effect") || countProviderUser(reviewed, "perform the original external operation") != 1 {
				t.Fatal("Continue did not use a new reviewed instruction and canonical history")
			}
			continueOnce.Do(func() { close(continueRelease) })
			for _, message := range pending {
				body := receiveProviderRequest(t, requests)
				items := body["messages"].([]any)
				last := items[len(items)-1].(map[string]any)
				if countProviderUser(map[string]any{"messages": []any{last}}, message.Text) != 1 {
					t.Fatal("SDK delivered recovered input out of order")
				}
				urls := providerImageURLs(map[string]any{"messages": []any{last}})
				if len(urls) != 1 || urls[0] != "data:image/png;base64,"+message.Images[0].Data {
					t.Fatal("SDK lost or changed the recovered attachment")
				}
			}
			state = waitState(t, s, func(st State) bool { return !st.Running })
			if state.Runtime.Phase != "complete" || state.Error != "" || calls.Load() != int64(5+len(pending)) || connector.calls.Load() != 1 {
				t.Fatalf("reviewed recovery replayed an external operation or failed: %+v", state)
			}
		})
	}
}
