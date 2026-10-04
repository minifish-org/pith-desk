package desk

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestConnectionProbeUsesPithToolsWithoutSavingOrRunningTools(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer unsaved-probe-key" {
			t.Error("probe lost unsaved credentials")
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["tools"] == nil || body["max_tokens"] != float64(256) {
			t.Errorf("probe request is not a small tool probe: %v", body)
		}
		if strings.Contains(string(mustJSON(t, body)), "workspace-secret") {
			t.Error("probe loaded a workspace")
		}
		startSSE(w)
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"index": 0, "id": "probe", "type": "function", "function": map[string]any{"name": "connection_check", "arguments": `{"ok":true}`}}}}}}})
		finishSSE(w, "tool_calls")
	}))
	defer server.Close()
	s, _, dataDir := configuredService(t, server.URL)
	before := s.Snapshot()
	configBefore, _ := os.ReadFile(dataDir + "/settings.json")
	result, err := s.TestConnection(context.Background(), ConfigInput{BaseURL: server.URL + "/v1", Model: "deepseek-flash", APIKey: "unsaved-probe-key"})
	if err != nil || !result.OK || !result.ToolCalling {
		t.Fatalf("probe failed: %+v %v", result, err)
	}
	configAfter, _ := os.ReadFile(dataDir + "/settings.json")
	if string(configAfter) != string(configBefore) || len(s.Snapshot().Messages) != len(before.Messages) || s.Snapshot().Running {
		t.Fatal("probe changed config or conversation")
	}
}

func TestConnectionFailureDoesNotEchoSecretsAndCancellationReleasesProbe(t *testing.T) {
	started := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.Header.Get("Authorization"), "bad-key") {
			w.WriteHeader(401)
			_, _ = w.Write([]byte(`{"error":{"message":"bad-key and response-secret rejected","type":"invalid_api_key"}}`))
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		startSSE(w)
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": "Testing"}}}})
		started <- struct{}{}
		<-r.Context().Done()
	}))
	defer server.Close()
	s, _, _ := configuredService(t, server.URL)
	result, err := s.TestConnection(context.Background(), ConfigInput{BaseURL: server.URL + "/v1", Model: "deepseek-flash", APIKey: "bad-key"})
	if err != nil || result.OK || result.Kind != "credentials" || strings.Contains(result.Message, "bad-key") || strings.Contains(result.Message, "response-secret") {
		t.Fatalf("unsafe probe failure: %+v %v", result, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := s.TestConnection(ctx, ConfigInput{BaseURL: server.URL + "/v1", Model: "deepseek-flash", APIKey: "waiting-key"})
		done <- err
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("probe never started")
	}
	if err := s.Configure(ConfigInput{BaseURL: server.URL + "/v1", Model: "deepseek-flash"}); err == nil {
		t.Fatal("configuration changed during a probe")
	}
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancellation was hidden")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("probe did not cancel")
	}
	if err := s.Configure(ConfigInput{BaseURL: server.URL + "/v1", Model: "deepseek-flash"}); err != nil {
		t.Fatal(err)
	}
}

func TestUsagePersistsAndDiagnosticsExcludePrivateData(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		startSSE(w)
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": "private-answer"}}}, "usage": map[string]any{"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120}})
		finishSSE(w, "stop")
	}))
	defer server.Close()
	s, workspace, dataDir := configuredService(t, server.URL)
	if err := s.Send("private-question"); err != nil {
		t.Fatal(err)
	}
	state := waitState(t, s, func(st State) bool { return !st.Running })
	// finishSSE's terminal provider usage (10 + 5) is authoritative, not
	// the provisional usage on the earlier streaming chunk.
	if state.Runtime.Phase != "complete" || state.Runtime.Usage.Total != 15 || state.Runtime.Usage.Input != 10 || state.Runtime.Usage.Output != 5 || state.Runtime.ContextTokens == 0 {
		t.Fatalf("missing Pith usage: %+v", state.Runtime)
	}
	s.Close()
	reopened, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if reopened.Snapshot().Runtime.Usage.Total != 15 {
		t.Fatal("usage lost on restart")
	}
	diagnostic, err := reopened.Diagnostics()
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"private-question", "private-answer", "fixture-private-key", workspace, dataDir, state.ActiveID, server.URL} {
		if strings.Contains(diagnostic, secret) {
			t.Fatalf("diagnostic leaked %q", secret)
		}
	}
}

func TestInterruptedRunIsExplicitlyContinuedWithHistory(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if requests.Add(1) == 1 {
			startSSE(w)
			sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": "Existing result"}}}})
			finishSSE(w, "stop")
			return
		}
		payload := string(mustJSON(t, body))
		if !strings.Contains(payload, "Existing result") || !strings.Contains(payload, "Do not repeat completed writes") {
			t.Error("continuation lost history or replay warning")
		}
		startSSE(w)
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": "Reviewed and continued"}}}})
		finishSSE(w, "stop")
	}))
	defer server.Close()
	s, _, dataDir := configuredService(t, server.URL)
	if err := s.Send("First task"); err != nil {
		t.Fatal(err)
	}
	state := waitState(t, s, func(st State) bool { return !st.Running })
	s.Close()
	status := state.Runtime
	status.Phase = "working"
	if err := writeJSON(s.receiptFile(state.ActiveID), runReceipt{Runtime: status}); err != nil {
		t.Fatal(err)
	}
	reopened, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if reopened.Snapshot().Failure == nil || requests.Load() != 1 {
		t.Fatal("restart resumed actions automatically or lost interruption")
	}
	if err := reopened.ContinueTask("wrong-id"); err == nil {
		t.Fatal("continued the wrong conversation")
	}
	if err := reopened.ContinueTask(state.ActiveID); err != nil {
		t.Fatal(err)
	}
	state = waitState(t, reopened, func(st State) bool { return !st.Running })
	if state.Failure != nil || countText(state.Messages, "Reviewed and continued") != 1 || countText(state.Messages, "First task") != 1 {
		t.Fatalf("bad continuation: %+v", state)
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestProbeRejectsIncompatibleToolsAndNewEndpointCredentialReuse(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		startSSE(w)
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": "I do not call tools"}}}})
		finishSSE(w, "stop")
	}))
	defer server.Close()
	s, _, _ := configuredService(t, server.URL)
	result, err := s.TestConnection(context.Background(), ConfigInput{BaseURL: server.URL + "/v1", Model: "deepseek-flash"})
	if err != nil || result.OK || result.Kind != "tool-calling" {
		t.Fatalf("text-only probe accepted: %+v %v", result, err)
	}
	_, err = s.TestConnection(context.Background(), ConfigInput{BaseURL: server.URL + "/other", Model: "deepseek-flash"})
	if err == nil || calls.Load() != 1 {
		t.Fatal("hidden saved key sent to a changed endpoint")
	}
}

func TestShutdownCancelsOutstandingConnectionTest(t *testing.T) {
	started := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body any
		json.NewDecoder(r.Body).Decode(&body)
		startSSE(w)
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": "Working"}}}})
		started <- struct{}{}
		<-r.Context().Done()
	}))
	defer server.Close()
	s, _, _ := configuredService(t, server.URL)
	done := make(chan error, 1)
	go func() {
		_, err := s.TestConnection(context.Background(), ConfigInput{BaseURL: server.URL + "/v1", Model: "deepseek-flash"})
		done <- err
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("probe did not start")
	}
	closed := make(chan struct{})
	go func() { s.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown left probe alive")
	}
	if err := <-done; err == nil {
		t.Fatal("shutdown cancellation hidden")
	}
}

func TestProviderFailureIsPersistedAndRepairDoesNotReplayTask(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer repaired-key" {
			w.WriteHeader(401)
			w.Write([]byte(`{"error":{"message":"fixture-private-key response-private auth rejected","type":"invalid_api_key"}}`))
			return
		}
		startSSE(w)
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": "Repaired"}}}})
		finishSSE(w, "stop")
	}))
	defer server.Close()
	s, _, dataDir := configuredService(t, server.URL)
	if err := s.Send("Failed task"); err != nil {
		t.Fatal(err)
	}
	st := waitState(t, s, func(st State) bool { return !st.Running })
	if st.Failure == nil || st.Failure.Kind != "credentials" || st.Failure.CanContinue || st.Runtime.Phase != "error" {
		t.Fatalf("unclear auth failure: %+v", st.Failure)
	}
	data, err := os.ReadFile(s.receiptFile(st.ActiveID))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "response-private") || strings.Contains(string(data), "fixture-private-key") {
		t.Fatal("receipt contains raw provider body")
	}
	s.Close()
	s, err = New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if s.Snapshot().Failure == nil || s.Snapshot().Failure.Kind != "credentials" {
		t.Fatal("failure lost on restart")
	}
	if err := s.Configure(ConfigInput{BaseURL: server.URL + "/v1", Model: "deepseek-flash", APIKey: "repaired-key"}); err != nil {
		t.Fatal(err)
	}
	if err := s.ContinueTask(st.ActiveID); err != nil {
		t.Fatal(err)
	}
	st = waitState(t, s, func(st State) bool { return !st.Running })
	if st.Failure != nil || countText(st.Messages, "Failed task") != 1 || countText(st.Messages, "Repaired") != 1 {
		t.Fatalf("repair did not preserve history: %+v", st)
	}
}
