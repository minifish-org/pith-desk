package desk

import (
	"encoding/json"
	"image/color"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"

	aitypes "github.com/minifish-org/pith/packages/ai/types"
)

func TestPendingMessagesDefaultQueueEditDeleteAndExplicitSteer(t *testing.T) {
	requests := make(chan map[string]any, 4)
	firstFinish, secondFinish := make(chan struct{}), make(chan struct{})
	var firstOnce, secondOnce sync.Once
	t.Cleanup(func() { firstOnce.Do(func() { close(firstFinish) }); secondOnce.Do(func() { close(secondFinish) }) })
	var count atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		requests <- body
		startSSE(w)
		w.(http.Flusher).Flush()
		var finish <-chan struct{}
		switch count.Add(1) {
		case 1:
			finish = firstFinish
		case 2:
			finish = secondFinish
		}
		if finish != nil {
			select {
			case <-finish:
			case <-r.Context().Done():
				return
			}
		}
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": "done"}}}})
		finishSSE(w, "stop")
	}))
	t.Cleanup(provider.Close)
	s, _, _ := configuredService(t, provider.URL)
	id := s.Snapshot().ActiveID
	image := imageFixture(t, color.RGBA{B: 255, A: 255})
	if err := s.Send("start"); err != nil {
		t.Fatal(err)
	}
	_ = receiveProviderRequest(t, requests)
	// Identical text makes accidental FIFO matching visible after promotion.
	for i := 0; i < 3; i++ {
		if err := s.QueueMessage(id, "same", "", image); err != nil {
			t.Fatal(err)
		}
	}
	queued := s.Snapshot().QueuedMessages
	for _, message := range queued {
		if message.Mode != QueueFollowUp {
			t.Fatal("default input steered the run")
		}
	}
	if err := s.MutateQueuedMessage("other-conversation", queued[0].ID, "delete", ""); err == nil {
		t.Fatal("modified another conversation")
	}
	if err := s.MutateQueuedMessage(id, queued[0].ID, "edit", "edited"); err != nil {
		t.Fatal(err)
	}
	if err := s.MutateQueuedMessage(id, queued[1].ID, "delete", ""); err != nil {
		t.Fatal(err)
	}
	if err := s.MutateQueuedMessage(id, queued[2].ID, "steer", ""); err != nil {
		t.Fatal(err)
	}
	if count.Load() != 1 {
		t.Fatal("steering interrupted an in-flight model response")
	}
	firstOnce.Do(func() { close(firstFinish) })
	second := receiveProviderRequest(t, requests)
	if countProviderUser(second, "same") != 1 || countProviderUser(second, "edited") != 0 || len(providerImageURLs(second)) != 1 {
		t.Fatalf("explicit instruction did not precede queued input: %v", second["messages"])
	}
	state := waitState(t, s, func(st State) bool { return len(st.QueuedMessages) == 1 })
	if state.QueuedMessages[0].ID != queued[0].ID || state.QueuedMessages[0].Text != "edited" {
		t.Fatal("delivery removed the wrong identical pending input")
	}
	if err := s.MutateQueuedMessage(id, queued[2].ID, "edit", "too late"); err == nil {
		t.Fatal("edited consumed instruction")
	}
	secondOnce.Do(func() { close(secondFinish) })
	third := receiveProviderRequest(t, requests)
	if countProviderUser(third, "same") != 1 || countProviderUser(third, "edited") != 1 || len(providerImageURLs(third)) != 2 {
		t.Fatalf("edit/delete lost images or replayed input: %v", third["messages"])
	}
	state = waitState(t, s, func(st State) bool { return !st.Running })
	if state.Error != "" || len(state.QueuedMessages) != 0 || count.Load() != 3 {
		t.Fatalf("pending mutations did not settle: %s, requests=%d", state.Error, count.Load())
	}
}

func TestPendingMutationsDurableRecoveryAndIdleEditsPreserveImages(t *testing.T) {
	var calls atomic.Int32
	started := make(chan struct{})
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		startSSE(w)
		if calls.Add(1) == 1 {
			w.(http.Flusher).Flush()
			close(started)
			<-r.Context().Done()
			return
		}
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": "continued"}}}})
		finishSSE(w, "stop")
	}))
	defer provider.Close()
	s, _, data := configuredService(t, provider.URL)
	id := s.Snapshot().ActiveID
	image := imageFixture(t, color.RGBA{R: 255, A: 255})
	if err := s.Send("start"); err != nil {
		t.Fatal(err)
	}
	<-started
	for _, message := range []struct {
		text string
		mode string
	}{{"original", QueueFollowUp}, {"delete me", QueueFollowUp}, {"first instruction", QueueSteer}} {
		if err := s.QueueMessage(id, message.text, message.mode, image); err != nil {
			t.Fatal(err)
		}
	}
	queued := s.Snapshot().QueuedMessages
	if err := s.MutateQueuedMessage(id, queued[0].ID, "edit", "edited before restart"); err != nil {
		t.Fatal(err)
	}
	if err := s.MutateQueuedMessage(id, queued[0].ID, "steer", ""); err != nil {
		t.Fatal(err)
	}
	if err := s.MutateQueuedMessage(id, queued[1].ID, "delete", ""); err != nil {
		t.Fatal(err)
	}
	s.Close()
	reopened, err := New(data)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reopened.Close)
	state := reopened.Snapshot()
	if len(state.QueuedMessages) != 2 || state.QueuedMessages[0].ID != queued[2].ID || state.QueuedMessages[1].ID != queued[0].ID || state.QueuedMessages[1].Mode != QueueSteer || state.QueuedMessages[1].Images[0] != image {
		t.Fatalf("recovery lost mutation/order/image: %+v", state.QueuedMessages)
	}
	if err := reopened.MutateQueuedMessage(id, queued[0].ID, "edit", "edited during recovery"); err != nil {
		t.Fatal(err)
	}
	if err := reopened.MutateQueuedMessage(id, queued[2].ID, "delete", ""); err != nil {
		t.Fatal(err)
	}
	if err := reopened.MutateQueuedMessage(id, queued[0].ID, "steer", ""); err == nil {
		t.Fatal("steered an interrupted task before reviewed continuation")
	}
	reopened.Close()
	restored, err := New(data)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	state = restored.Snapshot()
	if calls.Load() != 1 || len(state.QueuedMessages) != 1 || state.QueuedMessages[0].Text != "edited during recovery" || state.QueuedMessages[0].Images[0] != image {
		t.Fatalf("idle edit/delete was not durable: %+v, requests=%d", state.QueuedMessages, calls.Load())
	}
	// Image-only edits are valid and keep the original attachment.
	if err := restored.MutateQueuedMessage(id, queued[0].ID, "edit", ""); err != nil {
		t.Fatal(err)
	}
	if err := restored.ContinueTask(id); err != nil {
		t.Fatal(err)
	}
	state = waitState(t, restored, func(st State) bool { return !st.Running })
	if state.Error != "" || len(state.QueuedMessages) != 0 {
		t.Fatalf("mutated recovery did not complete: %s", state.Error)
	}
	images := 0
	for _, message := range state.Messages {
		if message.Role == aitypes.UserMessageRole {
			images += len(message.Images)
		}
	}
	if images != 1 {
		t.Fatalf("recovered attachment count=%d", images)
	}
}
