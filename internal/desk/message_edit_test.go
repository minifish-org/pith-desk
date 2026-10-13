package desk

import (
	"encoding/json"
	"errors"
	"fmt"
	"image/color"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/minifish-org/pith/packages/durable"
)

func TestEditMessageReplacesSuffixPreservesImagesContextAndHistory(t *testing.T) {
	requests := make(chan map[string]any, 4)
	var count atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		requests <- body
		n := count.Add(1)
		startSSE(w)
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": fmt.Sprintf("Reply %d", n)}}}})
		finishSSE(w, "stop")
	}))
	t.Cleanup(provider.Close)
	s, _, data := configuredService(t, provider.URL)
	id := s.Snapshot().ActiveID
	configureVision(t, s, provider.URL)
	image := imageFixture(t, color.RGBA{R: 255, A: 255})
	if err := s.Send("Keep earlier context"); err != nil {
		t.Fatal(err)
	}
	_ = receiveProviderRequest(t, requests)
	waitState(t, s, func(state State) bool { return !state.Running })
	if err := s.Send("Original question", image); err != nil {
		t.Fatal(err)
	}
	_ = receiveProviderRequest(t, requests)
	waitState(t, s, func(state State) bool { return !state.Running })
	if err := s.Send("Later follow-up"); err != nil {
		t.Fatal(err)
	}
	_ = receiveProviderRequest(t, requests)
	before := waitState(t, s, func(state State) bool { return !state.Running })
	if len(before.Messages) != 6 {
		t.Fatalf("messages: %+v", before.Messages)
	}
	if err := s.EditMessage(id, before.Messages[2].ID, before.Messages[5].ID, "Revised question 中文"); err != nil {
		t.Fatal(err)
	}
	request := receiveProviderRequest(t, requests)
	context, _ := json.Marshal(request["messages"])
	for _, text := range []string{"Keep earlier context", "Reply 1", "Revised question 中文"} {
		if !strings.Contains(string(context), text) {
			t.Fatalf("missing context %q: %s", text, context)
		}
	}
	for _, text := range []string{"Original question", "Later follow-up", "Reply 2", "Reply 3"} {
		if strings.Contains(string(context), text) {
			t.Fatalf("obsolete context %q reached model: %s", text, context)
		}
	}
	if urls := providerImageURLs(request); len(urls) != 1 || urls[0] != "data:image/png;base64,"+image.Data {
		t.Fatal("edited message lost its original image")
	}
	finished := waitState(t, s, func(state State) bool { return !state.Running })
	var texts []string
	for _, message := range finished.Messages {
		texts = append(texts, message.Text)
	}
	if !reflect.DeepEqual(texts, []string{"Keep earlier context", "Reply 1", "Revised question 中文", "Reply 4"}) {
		t.Fatalf("active suffix was not replaced: %v", texts)
	}
	if len(finished.Messages[2].Images) != 1 || finished.Messages[2].Timestamp <= 0 {
		t.Fatal("new message lost its image or time")
	}
	history, err := s.History(id)
	if err != nil {
		t.Fatal(err)
	}
	var preserved bool
	for _, node := range history {
		if node.Text == "Original question" && !node.Active {
			preserved = true
		}
	}
	if !preserved {
		t.Fatal("original branch was destroyed")
	}
	s.Close()
	reopened, err := New(data)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if !reflect.DeepEqual(reopened.Snapshot().Messages, finished.Messages) {
		t.Fatal("edited transcript changed after restart")
	}
}

func TestEditMessageRejectsInvalidOrStaleTargetsAndFailedAdmissionWithoutRewinding(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		startSSE(w)
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": "Original reply"}}}})
		finishSSE(w, "stop")
	}))
	t.Cleanup(provider.Close)
	s, _, _ := configuredService(t, provider.URL)
	id := s.Snapshot().ActiveID
	if err := s.Send("Original question"); err != nil {
		t.Fatal(err)
	}
	before := waitState(t, s, func(state State) bool { return !state.Running })
	user, last := before.Messages[0].ID, before.Messages[len(before.Messages)-1].ID
	for _, input := range []struct{ id, message, last, text string }{
		{id, user, "stale", "Revised"}, {id, user, "", "Revised"},
		{id, last, last, "Revised"}, {id, "missing", last, "Revised"},
		{"different", user, last, "Revised"}, {id, user, last, "   "},
	} {
		if err := s.EditMessage(input.id, input.message, input.last, input.text); err == nil {
			t.Fatalf("invalid edit accepted: %+v", input)
		}
		if !reflect.DeepEqual(s.Snapshot().Messages, before.Messages) {
			t.Fatal("rejected edit altered visible history")
		}
	}
	s.journals.open = func(string) (durable.Storage, error) { return nil, errors.New("injected admission failure") }
	if err := s.EditMessage(id, user, last, "Revised"); err == nil || !strings.Contains(err.Error(), "injected admission failure") {
		t.Fatalf("admission: %v", err)
	}
	if !reflect.DeepEqual(s.Snapshot().Messages, before.Messages) || s.Snapshot().Running {
		t.Fatal("failed admission altered history or left a task running")
	}
	manager, err := s.readConversationSessionLocked(id)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	if !reflect.DeepEqual(messagesFrom(manager), before.Messages) {
		t.Fatal("failed admission rewound the saved branch")
	}
}
