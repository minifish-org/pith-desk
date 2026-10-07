package desk

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	agenttypes "github.com/minifish-org/pith/packages/agent/types"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
)

func TestQueueStartupSteeringAndFollowUpConsumeOnlyNewMessages(t *testing.T) {
	initializeEntered, releaseInitialize := make(chan struct{}), make(chan struct{})
	var initializeOnce, releaseOnce sync.Once
	t.Cleanup(func() { releaseOnce.Do(func() { close(releaseInitialize) }) })
	connector := newDeskMCPFixture(t, "", func(_ http.ResponseWriter, r *http.Request) bool {
		initializeOnce.Do(func() { close(initializeEntered) })
		select {
		case <-releaseInitialize:
			return true
		case <-r.Context().Done():
			return false
		}
	})
	firstFinish, secondFinish := make(chan struct{}), make(chan struct{})
	var firstOnce, secondOnce sync.Once
	t.Cleanup(func() { firstOnce.Do(func() { close(firstFinish) }); secondOnce.Do(func() { close(secondFinish) }) })
	requests := make(chan map[string]any, 3)
	var number atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		requests <- body
		startSSE(w)
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": "Working"}}}})
		finish := firstFinish
		if number.Add(1) > 1 {
			finish = secondFinish
		}
		select {
		case <-finish:
		case <-r.Context().Done():
			return
		}
		finishSSE(w, "stop")
	}))
	t.Cleanup(provider.Close)
	s, folder, _ := configuredService(t, provider.URL)
	id := s.Snapshot().ActiveID
	manager, err := openDeskSession(s.sessionFile(id), id, folder)
	if err != nil {
		t.Fatal(err)
	}
	oldUser := agenttypes.NewAgentMessageFromMessage(aitypes.NewUserMessageVariant(aitypes.NewUserMessage("same message", 1)))
	raw, _ := json.Marshal(oldUser)
	if _, err := manager.AppendMessage(raw); err != nil {
		t.Fatal(err)
	}
	assistant := aitypes.NewAssistantMessage(aitypes.ApiOpenAICompletions, aitypes.ProviderDeepSeek, "deepseek-flash", 1)
	assistant.Content = []aitypes.ContentBlock{aitypes.TextBlock("old reply")}
	assistant.StopReason = aitypes.StopReasonStop
	raw, _ = json.Marshal(agenttypes.NewAgentMessageFromMessage(aitypes.NewAssistantMessageVariant(assistant)))
	if _, err := manager.AppendMessage(raw); err != nil {
		t.Fatal(err)
	}
	manager.Close()
	if err := s.SaveMCP(MCPInput{Name: "startup", Type: "http", URL: connector.server.URL, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if err := s.Send("same message"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-initializeEntered:
	case <-time.After(5 * time.Second):
		t.Fatal("startup did not reach MCP initialization")
	}
	if err := s.QueueMessage(id, "same message", QueueSteer); err != nil {
		t.Fatal(err)
	}
	if queued := s.Snapshot().QueuedMessages; len(queued) != 1 || queued[0].Mode != QueueSteer {
		t.Fatal("startup queue disappeared before a Pith user message was accepted")
	}
	if err := s.QueueMessage("inactive", "wrong conversation", QueueSteer); err == nil {
		t.Fatal("queued a message for another conversation")
	}
	releaseOnce.Do(func() { close(releaseInitialize) })
	first := receiveProviderRequest(t, requests)
	if countProviderUser(first, "same message") != 3 {
		t.Fatalf("Pith lost a startup steering message or reused old history: %v", first["messages"])
	}
	waitState(t, s, func(st State) bool { return len(st.QueuedMessages) == 0 && countText(st.Messages, "Working") == 1 })
	if err := s.QueueMessage(id, "same message", QueueFollowUp); err != nil {
		t.Fatal(err)
	}
	if len(s.Snapshot().QueuedMessages) != 1 {
		t.Fatal("historical duplicate text consumed a new follow-up")
	}
	firstOnce.Do(func() { close(firstFinish) })
	second := receiveProviderRequest(t, requests)
	if countProviderUser(second, "same message") != 4 {
		t.Fatalf("Pith did not execute the follow-up after the first response: %v", second["messages"])
	}
	waitState(t, s, func(st State) bool { return len(st.QueuedMessages) == 0 })
	secondOnce.Do(func() { close(secondFinish) })
	state := waitState(t, s, func(st State) bool { return !st.Running })
	if state.Error != "" || countText(state.Messages, "same message") != 4 {
		t.Fatalf("queued run failed: %+v", state)
	}
	if err := s.QueueMessage(id, "too late", QueueFollowUp); err == nil {
		t.Fatal("completed run acknowledged a queued message")
	}
}

func TestAbortClearsQueuedMessagesAndNeverCarriesThemToNextRun(t *testing.T) {
	var requests atomic.Int32
	canceled := make(chan struct{})
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		startSSE(w)
		if requests.Add(1) == 1 {
			sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": "Working"}}}})
			<-r.Context().Done()
			close(canceled)
			return
		}
		encoded, _ := json.Marshal(body["messages"])
		if strings.Contains(string(encoded), "Canceled addition") {
			t.Error("canceled follow-up appeared in the next run")
		}
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": "Next task"}}}})
		finishSSE(w, "stop")
	}))
	t.Cleanup(provider.Close)
	s, _, _ := configuredService(t, provider.URL)
	id := s.Snapshot().ActiveID
	if err := s.Send("Start"); err != nil {
		t.Fatal(err)
	}
	waitState(t, s, func(st State) bool { return countText(st.Messages, "Working") == 1 })
	if err := s.QueueMessage(id, "Canceled addition", QueueFollowUp); err != nil {
		t.Fatal(err)
	}
	if err := s.QueueMessage(id, "invalid mode", "unknown"); err == nil {
		t.Fatal("invalid queue mode accepted")
	}
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _ = s.QueueMessage(id, "Canceled addition", QueueFollowUp) }()
	}
	s.Abort()
	wg.Wait()
	if len(s.Snapshot().QueuedMessages) != 0 {
		t.Fatal("abort left queued messages visible")
	}
	if err := s.QueueMessage(id, "Canceled addition", QueueFollowUp); err == nil {
		t.Fatal("queue accepted a message after abort")
	}
	waitState(t, s, func(st State) bool { return !st.Running })
	select {
	case <-canceled:
	case <-time.After(5 * time.Second):
		t.Fatal("provider was not canceled")
	}
	if err := s.Send("Next"); err != nil {
		t.Fatal(err)
	}
	state := waitState(t, s, func(st State) bool { return !st.Running })
	if state.Error != "" || len(state.QueuedMessages) != 0 || countText(state.Messages, "Canceled addition") != 0 {
		t.Fatalf("canceled queue leaked across runs: %+v", state)
	}
}

func TestQueueRejectsAfterPithEndsBeforeServiceCleanup(t *testing.T) {
	finish := make(chan struct{})
	var finishOnce sync.Once
	t.Cleanup(func() { finishOnce.Do(func() { close(finish) }) })
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		startSSE(w)
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": "Working"}}}})
		select {
		case <-finish:
		case <-r.Context().Done():
			return
		}
		finishSSE(w, "stop")
	}))
	t.Cleanup(provider.Close)
	s, _, _ := configuredService(t, provider.URL)
	id := s.Snapshot().ActiveID
	if err := s.Send("Start"); err != nil {
		t.Fatal(err)
	}
	waitState(t, s, func(st State) bool { return countText(st.Messages, "Working") == 1 })
	s.mu.Lock()
	session := s.active.session
	s.mu.Unlock()
	ended, release := make(chan struct{}), make(chan struct{})
	var endedOnce, releaseOnce sync.Once
	t.Cleanup(func() { releaseOnce.Do(func() { close(release) }) })
	unsubscribe := session.Subscribe(func(event codingagent.SessionEvent) {
		if event.Type == codingagent.SessionEventAgentEnd {
			endedOnce.Do(func() { close(ended) })
			<-release
		}
	})
	defer unsubscribe()
	finishOnce.Do(func() { close(finish) })
	select {
	case <-ended:
	case <-time.After(5 * time.Second):
		t.Fatal("Pith did not signal the completed run")
	}
	if !s.Snapshot().Running {
		t.Fatal("fixture did not hold the service cleanup boundary")
	}
	if err := s.QueueMessage(id, "late addition", QueueSteer); err == nil {
		t.Fatal("Pith's completed run falsely acknowledged a new queue message")
	}
	releaseOnce.Do(func() { close(release) })
	waitState(t, s, func(st State) bool { return !st.Running })
}

func receiveProviderRequest(t *testing.T, requests <-chan map[string]any) map[string]any {
	t.Helper()
	select {
	case request := <-requests:
		return request
	case <-time.After(5 * time.Second):
		t.Fatal("provider request did not arrive")
		return nil
	}
}

func countProviderUser(body map[string]any, text string) int {
	count := 0
	items, _ := body["messages"].([]any)
	for _, item := range items {
		message, _ := item.(map[string]any)
		if message["role"] != "user" {
			continue
		}
		content, _ := message["content"].(string)
		if blocks, ok := message["content"].([]any); ok {
			for _, block := range blocks {
				value, _ := block.(map[string]any)
				if piece, ok := value["text"].(string); ok {
					content += piece
				}
			}
		}
		if content == text {
			count++
		}
	}
	return count
}
