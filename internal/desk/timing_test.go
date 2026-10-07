package desk

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	aitypes "github.com/minifish-org/pith/packages/ai/types"
)

func TestTaskTimingTicksResetsAndPersists(t *testing.T) {
	requests := make(chan chan struct{}, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		startSSE(w)
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": "Answer"}}}})
		release := make(chan struct{})
		requests <- release
		select {
		case <-release:
			finishSSE(w, "stop")
		case <-r.Context().Done():
		}
	}))
	defer server.Close()
	s, _, dataDir := configuredService(t, server.URL)
	defer s.Close()
	var last State
	for turn := 0; turn < 2; turn++ {
		if err := s.Send("Question"); err != nil {
			t.Fatal(err)
		}
		var release chan struct{}
		select {
		case release = <-requests:
		case <-time.After(30 * time.Second):
			t.Fatal("provider request did not start")
		}
		live := s.Snapshot().Runtime.Timing
		if live.StartedAt == "" || live.StartedAt == last.Runtime.Timing.StartedAt || live.OutputTokens != 0 || live.Partial {
			t.Fatalf("task inherited old timing or output: %+v", live)
		}
		time.Sleep(25 * time.Millisecond)
		if s.Snapshot().Runtime.Timing.ElapsedMs <= live.ElapsedMs {
			t.Fatal("elapsed time did not advance without a stream event")
		}
		close(release)
		last = waitState(t, s, func(st State) bool { return !st.Running })
		if last.Runtime.Phase != "complete" || last.Runtime.Timing.ElapsedMs <= live.ElapsedMs || last.Runtime.Timing.OutputTokens != 5 || last.Runtime.Usage.Output != float64(5*(turn+1)) {
			t.Fatalf("timing must use this task's reported output, not session/input totals: %+v", last.Runtime)
		}
		time.Sleep(25 * time.Millisecond)
		if s.Snapshot().Runtime.Timing != last.Runtime.Timing {
			t.Fatal("completed task timing continued to advance")
		}
	}
	s.Close()
	reopened, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if reopened.Snapshot().Runtime.Timing != last.Runtime.Timing {
		t.Fatal("restart changed saved task duration or output")
	}
}

func TestStoppedTaskTimingFreezes(t *testing.T) {
	started := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		startSSE(w)
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": "Waiting"}}}})
		started <- struct{}{}
		<-r.Context().Done()
	}))
	defer server.Close()
	s, _, dataDir := configuredService(t, server.URL)
	defer s.Close()
	if err := s.Send("Question"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-time.After(30 * time.Second):
		t.Fatal("provider request did not start")
	}
	s.Abort()
	stopped := waitState(t, s, func(st State) bool { return !st.Running })
	if stopped.Runtime.Phase != "stopped" || stopped.Runtime.Timing.ElapsedMs <= 0 || stopped.Runtime.Timing.OutputTokens != 0 || stopped.Runtime.Timing.Partial {
		t.Fatalf("stopped task timing is missing or invents unreported output: %+v", stopped.Runtime)
	}
	time.Sleep(25 * time.Millisecond)
	if s.Snapshot().Runtime.Timing != stopped.Runtime.Timing {
		t.Fatal("stopped task timing continued to advance")
	}
	s.Close()
	reopened, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if reopened.Snapshot().Runtime.Timing != stopped.Runtime.Timing {
		t.Fatal("stopped timing lost on reopening")
	}
}

func TestTaskOutputIncludesUnpricedRequestsAndSummaries(t *testing.T) {
	s, _, conversation, _ := productFeatureService(t)
	config := normalizedConfig(s.config)
	config.BaseURL = "https://unpriced.example/v1"
	model, err := resolveConfiguredModel(config)
	if err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	s.active.Runtime.RunID = "latest"
	s.active.Runtime.Timing = TaskTiming{StartedAt: timestamp()}
	s.mu.Unlock()
	response := aitypes.NewAssistantMessage(model.Api, model.Provider, model.Id, 1)
	response.Usage = aitypes.Usage{Input: 1000, Output: 10, CacheRead: 9000, TotalTokens: 10010}
	s.recordCost(conversation.ID, "earlier", "agent", model, config, response)
	s.recordCost(conversation.ID, "latest", "agent", model, config, response)
	s.recordCost(conversation.ID, "latest", "compaction", model, config, response)
	state := s.Snapshot()
	if state.Runtime.Timing.OutputTokens != 20 || state.Runtime.Cost.RunUnknownRequests != 2 {
		t.Fatalf("task output is independent of price, input/cache and older requests: %+v", state.Runtime)
	}
}

func TestTaskTimingFreezesWhenStoppedImmediately(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		startSSE(w)
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": "Waiting"}}}})
		<-r.Context().Done()
	}))
	defer server.Close()
	s, _, _ := configuredService(t, server.URL)
	defer s.Close()
	if err := s.Send("Question"); err != nil {
		t.Fatal(err)
	}
	s.Abort()
	stopped := waitState(t, s, func(st State) bool { return !st.Running })
	if stopped.Runtime.Phase != "stopped" || stopped.Runtime.Timing.StartedAt == "" {
		t.Fatalf("immediately stopped task retained an active status: %+v", stopped.Runtime)
	}
	time.Sleep(25 * time.Millisecond)
	if s.Snapshot().Runtime.Timing != stopped.Runtime.Timing {
		t.Fatal("immediately stopped task clock continued to advance")
	}
}

func TestRecoveredTimingDoesNotCountDowntimeOrInventOldMetrics(t *testing.T) {
	s, _, conversation, dataDir := productFeatureService(t)
	s.Close()
	for _, timing := range []TaskTiming{{StartedAt: time.Now().Add(-24 * time.Hour).UTC().Format(time.RFC3339Nano), ElapsedMs: 1234, OutputTokens: 5}, {}} {
		runtime := RuntimeStatus{RunID: "checkpoint", Phase: "working", Model: "deepseek-flash", Timing: timing}
		if err := writeJSON(s.receiptFile(conversation.ID), runReceipt{Runtime: runtime}); err != nil {
			t.Fatal(err)
		}
		reopened, err := New(dataDir)
		if err != nil {
			t.Fatal(err)
		}
		state := reopened.Snapshot()
		reopened.Close()
		if state.Runtime.Phase != "interrupted" || !state.Runtime.Timing.Partial || state.Runtime.Timing.ElapsedMs != timing.ElapsedMs || state.Runtime.Timing.StartedAt != timing.StartedAt || state.Runtime.Timing.OutputTokens != timing.OutputTokens {
			t.Fatalf("recovery included downtime or fabricated timing: %+v", state.Runtime)
		}
	}
}
