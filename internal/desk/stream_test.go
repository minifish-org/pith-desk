package desk

import (
	"encoding/json"
	"fmt"
	ai "github.com/minifish-org/pith/packages/ai/types"
	ca "github.com/minifish-org/pith/packages/coding-agent"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func verifyVisibleStream(t *testing.T, protocol ai.Api) {
	t.Helper()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	emitted, release := make(chan struct{}), make(chan struct{})
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		emit := func(kind string, data any) {
			b, _ := json.Marshal(data)
			if kind != "" {
				fmt.Fprintf(w, "event: %s\n", kind)
			}
			fmt.Fprintf(w, "data: %s\n\n", b)
			w.(http.Flusher).Flush()
		}
		if protocol == ai.ApiOpenAICompletions {
			emit("", map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": "Visible partial text"}}}})
			close(emitted)
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
			fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
		} else {
			emit("response.created", map[string]any{"type": "response.created", "response": map[string]any{"id": "resp", "model": "fixture", "status": "in_progress", "output": []any{}}})
			item := map[string]any{"id": "msg", "type": "message", "role": "assistant", "status": "in_progress", "content": []any{}}
			emit("response.output_item.added", map[string]any{"type": "response.output_item.added", "output_index": 0, "item": item})
			emit("response.output_text.delta", map[string]any{"type": "response.output_text.delta", "output_index": 0, "content_index": 0, "delta": "Visible partial text"})
			close(emitted)
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
			item["content"] = []any{map[string]any{"type": "output_text", "text": "Visible partial text", "annotations": []any{}}}
			item["status"] = "completed"
			emit("response.output_item.done", map[string]any{"type": "response.output_item.done", "output_index": 0, "item": item})
			emit("response.completed", map[string]any{"type": "response.completed", "response": map[string]any{"id": "resp", "model": "fixture", "status": "completed", "output": []any{item}, "usage": map[string]any{"input_tokens": 2, "output_tokens": 1, "total_tokens": 3}}})
		}
	}))
	defer provider.Close()
	data, workspace := t.TempDir(), t.TempDir()
	service, err := New(data)
	must(err)
	defer service.Close()
	w, err := service.AddWorkspace(workspace)
	must(err)
	_, err = service.CreateConversation(w.ID)
	must(err)
	contextWindow, maxTokens := float64(128000), float64(8192)
	must(service.SaveCustomConnection(CustomConnectionInput{ID: "custom-fixture", Name: "Fixture", BaseURL: provider.URL + "/v1", API: protocol, Models: []ca.ModelsJsonModel{{ID: "fixture", ContextWindow: &contextWindow, MaxTokens: &maxTokens}}}))
	must(service.SelectModel("custom-fixture", "fixture", "off"))
	must(service.Send("Stream a reply"))
	select {
	case <-emitted:
	case <-time.After(5 * time.Second):
		t.Fatal("provider did not start")
	}
	deadlinePartial := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadlinePartial) {
		snapshot := service.Snapshot()
		found := false
		for _, message := range snapshot.Messages {
			if message.Role == "assistant" && message.Text == "Visible partial text" {
				found = true
			}
		}
		if found {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	state := service.Snapshot()
	partial := ""
	for _, message := range state.Messages {
		if message.Role == "assistant" {
			partial += message.Text
		}
	}
	close(release)
	deadline := time.Now().Add(5 * time.Second)
	for service.Snapshot().Running && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	final := service.Snapshot()
	completed := ""
	for _, message := range final.Messages {
		if message.Role == "assistant" {
			completed += message.Text
		}
	}
	if !state.Running || partial != "Visible partial text" {
		t.Errorf("no visible output before completion: running=%v partial=%q", state.Running, partial)
	}
	if final.Running || final.Error != "" || completed != "Visible partial text" {
		t.Errorf("completion changed: running=%v error=%q text=%q", final.Running, final.Error, completed)
	}
}

func TestNormalizedProviderStreamsPublishBeforeCompletion(t *testing.T) {
	for _, protocol := range []ai.Api{ai.ApiOpenAICompletions, ai.ApiOpenAIResponses} {
		t.Run(string(protocol), func(t *testing.T) { verifyVisibleStream(t, protocol) })
	}
}

func TestOnlyAssistantTextDeltasAreVisible(t *testing.T) {
	service, _, _, _ := productFeatureService(t)
	runtime := service.active
	text := "visible"
	for _, kind := range []ai.AssistantMessageEventType{ai.AssistantEventThinkingDelta, ai.AssistantEventToolCallDelta, ai.AssistantEventTextEnd} {
		runtime.appendAssistantText(ai.AssistantMessageEvent{Type: kind, Delta: &text})
	}
	if len(runtime.Messages) != 0 {
		t.Fatal("reasoning or tool arguments became visible")
	}
	runtime.appendAssistantText(ai.AssistantMessageEvent{Type: ai.AssistantEventTextDelta, Delta: &text})
	if len(runtime.Messages) != 1 || runtime.Messages[0].Text != text {
		t.Fatal("normalized text delta missing")
	}
}
