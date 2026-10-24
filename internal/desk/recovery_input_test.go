package desk

import (
	"context"
	"encoding/json"
	"image/color"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	aitypes "github.com/minifish-org/pith/packages/ai/types"
)

func TestContinueRestoresOnlyUnrecordedAdmittedInputInExistingConversation(t *testing.T) {
	for _, window := range []struct {
		name             string
		recorded, branch bool
	}{{name: "before-prompt"}, {name: "after-prompt", recorded: true}, {name: "branched-before-prompt", branch: true}} {
		t.Run(window.name, func(t *testing.T) {
			requests := make(chan map[string]any, 8)
			var calls atomic.Int64
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
					return
				}
				n := calls.Add(1)
				requests <- body
				startSSE(w)
				w.(http.Flusher).Flush()
				if window.recorded && n == 2 {
					<-r.Context().Done()
					return
				}
				sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": "Task finished"}}}})
				finishSSE(w, "stop")
			}))
			defer provider.Close()
			s, _, dir := configuredService(t, provider.URL)
			// Identical text in an older task must not make the new admission look delivered.
			const text = "Translate the outline into Japanese"
			if err := s.Send(text); err != nil {
				t.Fatal(err)
			}
			receiveProviderRequest(t, requests)
			waitState(t, s, func(st State) bool { return !st.Running })
			id := s.Snapshot().ActiveID
			if window.branch {
				// Leave the old reply in a sibling branch before the next admission.
				if err := s.BranchConversation(id, s.Snapshot().Messages[0].ID, false); err != nil {
					t.Fatal(err)
				}
			}
			attachment := imageFixture(t, color.RGBA{B: 255, A: 255})
			if window.recorded {
				if err := s.Send(text, attachment); err != nil {
					t.Fatal(err)
				}
				receiveProviderRequest(t, requests)
			} else {
				// Commit the real admission, but do not resume the harness or append the prompt.
				s.mu.Lock()
				run := s.active
				run.Runtime.RunID, run.Runtime.Phase = newID(), "starting"
				err := s.files.WriteJSON(s.receiptFile(id), runReceipt{Runtime: run.Runtime})
				model, modelErr := resolveConfiguredModel(s.connections.config)
				if err != nil || modelErr != nil {
					s.mu.Unlock()
					t.Fatalf("fixture: %v %v", err, modelErr)
				}
				journal, err := run.admitDurableLocked(id, run.workspace, s.connections.taskConfig(), model, durableInput{RunID: run.Runtime.RunID, Text: text, Images: []aitypes.ImageContent{attachment}})
				s.mu.Unlock()
				if err != nil {
					t.Fatal(err)
				}
				if err := journal.harness.Close(context.Background()); err != nil {
					t.Fatal(err)
				}
			}
			s.Close()
			before := calls.Load()
			reopened, err := New(dir)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			st := reopened.Snapshot()
			if st.Failure == nil || st.Failure.Kind != "interrupted" || calls.Load() != before {
				t.Fatal("restart lost interruption or replayed a request")
			}
			if err := reopened.ContinueTask(id); err != nil {
				t.Fatal(err)
			}
			request := receiveProviderRequest(t, requests)
			raw, _ := json.Marshal(request["messages"])
			urls := providerImageURLs(request)
			if strings.Count(string(raw), text) != 2 || len(urls) != 1 || urls[0] != "data:image/png;base64,"+attachment.Data {
				t.Fatalf("admitted input lost or duplicated: text copies=%d image copies=%d", strings.Count(string(raw), text), len(urls))
			}
			if !strings.Contains(string(raw), "Do not repeat completed writes") {
				t.Fatal("recovery lost review instruction")
			}
			waitState(t, reopened, func(st State) bool { return !st.Running })
			if calls.Load() != before+1 {
				t.Fatal("Continue replayed earlier requests")
			}
		})
	}
}
