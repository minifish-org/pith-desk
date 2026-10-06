package desk

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	agenttypes "github.com/minifish-org/pith/packages/agent/types"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
)

func TestModelCatalogUsesSDKCapabilitiesAndDoesNotExposeCredentials(t *testing.T) {
	s, _, _ := configuredService(t, "http://127.0.0.1:1")
	catalog, err := s.Models("")
	if err != nil {
		t.Fatal(err)
	}
	providers := map[string]bool{}
	for _, provider := range catalog.Providers {
		providers[provider.ID] = true
	}
	for _, provider := range []string{"deepseek", "openai", "anthropic", "google", "mistral"} {
		if !providers[provider] {
			t.Errorf("missing native provider %s", provider)
		}
	}
	for _, provider := range catalog.Providers {
		if provider.ID == "openai-codex" && !provider.OAuth {
			t.Fatal("OAuth provider must advertise its login method")
		}
	}
	for _, model := range catalog.Models {
		if model.Provider == "deepseek" && model.ID == "deepseek-flash" {
			if !model.SupportsImages || !reflect.DeepEqual(model.ThinkingLevels, []string{"off", "low", "high", "max"}) {
				t.Fatalf("lost SDK capabilities: %+v", model)
			}
		}
	}
	encoded, _ := json.Marshal(catalog)
	if strings.Contains(string(encoded), "fixture-private-key") {
		t.Fatal("catalog leaked a key")
	}
	if _, err := s.Models("nonexistent"); err == nil {
		t.Fatal("accepted unknown provider")
	}
	snapshot := s.Snapshot()
	snapshot.Settings.ThinkingLevels[0] = "mutated"
	if s.Snapshot().Settings.ThinkingLevels[0] != "off" {
		t.Fatal("snapshot aliases service capability data")
	}
}

func sdkTestModel(t *testing.T, provider string, api aitypes.Api) string {
	t.Helper()
	runtime, err := modelRuntime()
	if err != nil {
		t.Fatal(err)
	}
	for _, model := range runtime.GetModels() {
		if string(model.Provider) == provider && model.Api == api && supportedDesktopModel(model) {
			return model.Id
		}
	}
	t.Fatalf("missing %s / %s model in SDK", provider, api)
	return ""
}

func TestProviderCredentialsSelectionAndEffortPersistIndependently(t *testing.T) {
	s, _, dataDir := configuredService(t, "http://127.0.0.1:1")
	model := sdkTestModel(t, "openai", aitypes.ApiOpenAIResponses)
	if err := s.Configure(ConfigInput{Provider: "openai", BaseURL: "http://127.0.0.1:2/v1", Model: model, APIKey: "openai-fixture-key", ThinkingLevel: "off"}); err != nil {
		t.Fatal(err)
	}
	if err := s.SelectModel("deepseek", "deepseek-flash", "max"); err != nil {
		t.Fatal(err)
	}
	if s.config.APIKey != "fixture-private-key" || s.config.ThinkingLevel != "max" {
		t.Fatal("switch lost provider credential or thinking")
	}
	before, _ := os.ReadFile(filepath.Join(dataDir, "settings.json"))
	if err := s.SelectModel("deepseek", "deepseek-flash", "medium"); err == nil {
		t.Fatal("unsupported effort accepted")
	}
	after, _ := os.ReadFile(filepath.Join(dataDir, "settings.json"))
	if !bytes.Equal(before, after) {
		t.Fatal("invalid selection changed settings")
	}
	s.Close()
	reopened, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if reopened.Snapshot().Settings.ThinkingLevel != "max" {
		t.Fatal("thinking level lost on restart")
	}
	if err := reopened.SelectModel("openai", model, "off"); err != nil {
		t.Fatal(err)
	}
	if reopened.config.APIKey != "openai-fixture-key" {
		t.Fatal("saved provider key not restored")
	}
	if err := reopened.Configure(ConfigInput{Provider: "openai", BaseURL: "http://127.0.0.1:3/v1", Model: model}); err != nil {
		t.Fatal(err)
	}
	if reopened.config.APIKey != "" {
		t.Fatal("key forwarded to a new endpoint")
	}
	next, err := validatedConfig(ConfigInput{Provider: "deepseek", BaseURL: "http://127.0.0.1:3/v1", Model: "deepseek-flash"}, reopened.config)
	if err != nil || next.APIKey != "" {
		t.Fatal("another provider inherited a saved key")
	}
}

func TestInvalidConfigDoesNotMutateProfilesAndFailedSelectionDoesNotLoseKeys(t *testing.T) {
	s, _, dataDir := configuredService(t, "http://127.0.0.1:1")
	before := mustJSON(t, s.config)
	if _, err := validatedConfig(ConfigInput{Provider: "deepseek", BaseURL: "not-a-url", Model: "deepseek-flash"}, s.config); err == nil {
		t.Fatal("invalid URL accepted")
	}
	if !bytes.Equal(before, mustJSON(t, s.config)) {
		t.Fatal("validation mutated current connections")
	}
	path := filepath.Join(dataDir, "settings.json")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	if err := s.SelectModel("deepseek", "deepseek-flash", "max"); err == nil {
		t.Fatal("failed save reported success")
	}
	if !bytes.Equal(before, mustJSON(t, s.config)) {
		t.Fatal("failed save changed selection/keys")
	}
}

func TestLegacyModelSettingsMigrationPreservesKeyAndOriginalHighDefault(t *testing.T) {
	dir := t.TempDir()
	raw := []byte(`{"baseUrl":"https://api.deepseek.com/v1","model":"deepseek-flash","apiKey":"legacy-key"}`)
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	s, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	st := s.Snapshot().Settings
	if st.Provider != "deepseek" || st.ThinkingLevel != "high" || !st.HasAPIKey {
		t.Fatalf("legacy settings lost: %+v", st)
	}
	stored, _ := os.ReadFile(filepath.Join(dir, "settings.json"))
	if !bytes.Equal(raw, stored) {
		t.Fatal("loading rewrote user's config")
	}
}

func TestDeepSeekSelectedEffortReachesActualAgentRequest(t *testing.T) {
	for _, effort := range []string{"low", "high", "max", "off"} {
		t.Run(effort, func(t *testing.T) {
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				_ = json.NewDecoder(r.Body).Decode(&body)
				if effort == "off" {
					if body["thinking"].(map[string]any)["type"] != "disabled" {
						t.Error("thinking still enabled")
					}
				} else if body["reasoning_effort"] != effort {
					t.Errorf("requested %s, sent %v", effort, body["reasoning_effort"])
				}
				requests.Add(1)
				startSSE(w)
				sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": "Selected effort reached the provider."}}}})
				finishSSE(w, "stop")
			}))
			defer server.Close()
			s, _, _ := configuredService(t, server.URL)
			if err := s.SelectModel("deepseek", "deepseek-flash", effort); err != nil {
				t.Fatal(err)
			}
			if err := s.Send("Test selected model"); err != nil {
				t.Fatal(err)
			}
			st := waitState(t, s, func(st State) bool { return !st.Running })
			if st.Failure != nil || requests.Load() != 1 || st.Runtime.ThinkingLevel != effort {
				t.Fatalf("agent failed: %+v", st)
			}
		})
	}
}

// Fixtures exercise native adapters end to end without real credentials or
// paid requests. Agent, connection test, and compaction must agree on protocol.
func TestNativeProvidersUsedForAgentProbeAndCompaction(t *testing.T) {
	for _, tc := range []struct {
		provider     string
		api          aitypes.Api
		path, header string
	}{
		{"openai", aitypes.ApiOpenAIResponses, "/v1/responses", "Authorization"},
		{"anthropic", aitypes.ApiAnthropicMessages, "/v1/messages", "X-Api-Key"},
		{"google", aitypes.ApiGoogleGenerativeAI, ":streamGenerateContent", "X-Goog-Api-Key"},
	} {
		t.Run(tc.provider, func(t *testing.T) {
			modelID := sdkTestModel(t, tc.provider, tc.api)
			runtime, _ := modelRuntime()
			level := thinkingLevels(runtime.GetModel(tc.provider, modelID))[0]
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if !strings.Contains(r.URL.Path, tc.path) {
					t.Errorf("wrong native API: %s", r.URL.Path)
				}
				key := r.Header.Get(tc.header)
				if key != "native-fixture-key" && key != "Bearer native-fixture-key" {
					t.Errorf("wrong credential header %s", tc.header)
				}
				var body map[string]any
				_ = json.NewDecoder(r.Body).Decode(&body)
				probe := strings.Contains(string(mustJSON(t, body)), "connection_check")
				requests.Add(1)
				nativeFixture(w, tc.api, modelID, probe)
			}))
			defer server.Close()
			s, _, _ := configuredService(t, server.URL)
			in := ConfigInput{Provider: tc.provider, BaseURL: server.URL + "/v1", Model: modelID, APIKey: "native-fixture-key", ThinkingLevel: level}
			probe, err := s.TestConnection(context.Background(), in)
			if err != nil || !probe.OK {
				t.Fatalf("native probe: %+v %v", probe, err)
			}
			if err := s.Configure(in); err != nil {
				t.Fatal(err)
			}
			if err := s.Send("Hello"); err != nil {
				t.Fatal(err)
			}
			st := waitState(t, s, func(st State) bool { return !st.Running })
			if st.Failure != nil || countText(st.Messages, "Native adapter works.") == 0 {
				t.Fatalf("native agent failed: %+v", st)
			}
			model, err := resolveConfiguredModel(s.config)
			if err != nil {
				t.Fatal(err)
			}
			summary, err := compactionPolicy(model, "native-fixture-key").Summarize(context.Background(), []agenttypes.AgentMessage{agenttypes.NewAgentMessageFromMessage(aitypes.NewUserMessageVariant(aitypes.NewUserMessage("Summarize", 1)))})
			if err != nil || summary != "Native adapter works." || requests.Load() != 3 {
				t.Fatalf("native summary %q: %v; requests %d", summary, err, requests.Load())
			}
		})
	}
}

func nativeFixture(w http.ResponseWriter, api aitypes.Api, model string, probe bool) {
	w.Header().Set("Content-Type", "text/event-stream")
	emit := func(event string, data any) {
		raw, _ := json.Marshal(data)
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, raw)
	}
	switch api {
	case aitypes.ApiGoogleGenerativeAI:
		part := map[string]any{"text": "Native adapter works."}
		if probe {
			part = map[string]any{"functionCall": map[string]any{"name": "connection_check", "args": map[string]any{"ok": true}}}
		}
		emit("message", map[string]any{"candidates": []any{map[string]any{"index": 0, "content": map[string]any{"role": "model", "parts": []any{part}}, "finishReason": "STOP"}}, "usageMetadata": map[string]any{"promptTokenCount": 2, "candidatesTokenCount": 1, "totalTokenCount": 3}})
	case aitypes.ApiAnthropicMessages:
		emit("message_start", map[string]any{"type": "message_start", "message": map[string]any{"id": "msg", "model": model, "role": "assistant", "content": []any{}, "usage": map[string]any{"input_tokens": 2, "output_tokens": 0}}})
		block := map[string]any{"type": "text", "text": ""}
		delta := map[string]any{"type": "text_delta", "text": "Native adapter works."}
		stop := "end_turn"
		if probe {
			block = map[string]any{"type": "tool_use", "id": "call", "name": "connection_check", "input": map[string]any{}}
			delta = map[string]any{"type": "input_json_delta", "partial_json": `{"ok":true}`}
			stop = "tool_use"
		}
		emit("content_block_start", map[string]any{"type": "content_block_start", "index": 0, "content_block": block})
		emit("content_block_delta", map[string]any{"type": "content_block_delta", "index": 0, "delta": delta})
		emit("content_block_stop", map[string]any{"type": "content_block_stop", "index": 0})
		emit("message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": stop}, "usage": map[string]any{"output_tokens": 1}})
		emit("message_stop", map[string]any{"type": "message_stop"})
	case aitypes.ApiOpenAIResponses:
		emit("response.created", map[string]any{"type": "response.created", "response": map[string]any{"id": "resp", "model": model, "status": "in_progress", "output": []any{}}})
		item := map[string]any{"id": "msg", "type": "message", "role": "assistant", "status": "in_progress", "content": []any{}}
		if probe {
			item = map[string]any{"id": "call", "call_id": "call", "type": "function_call", "name": "connection_check", "arguments": ""}
		}
		emit("response.output_item.added", map[string]any{"type": "response.output_item.added", "output_index": 0, "item": item})
		if probe {
			item["arguments"] = `{"ok":true}`
			emit("response.function_call_arguments.delta", map[string]any{"type": "response.function_call_arguments.delta", "item_id": "call", "output_index": 0, "delta": `{"ok":true}`})
		} else {
			item["content"] = []any{map[string]any{"type": "output_text", "text": "Native adapter works.", "annotations": []any{}}}
			emit("response.output_text.delta", map[string]any{"type": "response.output_text.delta", "output_index": 0, "content_index": 0, "delta": "Native adapter works."})
		}
		item["status"] = "completed"
		emit("response.output_item.done", map[string]any{"type": "response.output_item.done", "output_index": 0, "item": item})
		emit("response.completed", map[string]any{"type": "response.completed", "response": map[string]any{"id": "resp", "model": model, "status": "completed", "output": []any{item}, "usage": map[string]any{"input_tokens": 2, "output_tokens": 1, "total_tokens": 3}}})
	}
}

func TestSelectionIsBlockedDuringAgentAndProbeAndPreservesState(t *testing.T) {
	started := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		startSSE(w)
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": "Working"}}}})
		started <- struct{}{}
		<-r.Context().Done()
	}))
	defer server.Close()
	s, _, _ := configuredService(t, server.URL)
	if err := s.Send("Wait"); err != nil {
		t.Fatal(err)
	}
	<-started
	if err := s.SelectModel("deepseek", "deepseek-flash", "max"); err == nil {
		t.Fatal("model changed during agent run")
	}
	if s.Snapshot().Settings.ThinkingLevel != "high" {
		t.Fatal("rejected selection changed state")
	}
	s.Abort()
	waitState(t, s, func(st State) bool { return !st.Running })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = s.TestConnection(ctx, ConfigInput{BaseURL: server.URL + "/v1", Model: "deepseek-flash"})
	}()
	<-started
	if err := s.SelectModel("deepseek", "deepseek-flash", "max"); err == nil {
		t.Fatal("model changed during probe")
	}
	cancel()
	<-done
	if err := s.SelectModel("deepseek", "deepseek-flash", "max"); err != nil {
		t.Fatal(err)
	}
}

func TestSameModelIDUsesExplicitProviderAndLeavesSDKCatalogUntouched(t *testing.T) {
	runtime, err := modelRuntime()
	if err != nil {
		t.Fatal(err)
	}
	owners := map[string][]string{}
	for _, model := range runtime.GetModels() {
		provider := runtime.GetProvider(string(model.Provider))
		if supportedDesktopModel(model) && provider.Auth().APIKey != nil {
			owners[model.Id] = append(owners[model.Id], string(model.Provider))
		}
	}
	for id, providers := range owners {
		if len(providers) < 2 {
			continue
		}
		for _, provider := range providers {
			original := runtime.GetModel(provider, id)
			before := mustJSON(t, original)
			selected, err := resolveConfiguredModel(savedConfig{Provider: provider, Model: id, BaseURL: "http://127.0.0.1:1/v1"})
			if err != nil {
				t.Fatal(err)
			}
			if string(selected.Provider) != provider || selected.Api != original.Api || selected.BaseUrl != "http://127.0.0.1:1/v1" {
				t.Fatal("ambiguous model resolved to another provider")
			}
			if !bytes.Equal(before, mustJSON(t, runtime.GetModel(provider, id))) {
				t.Fatal("endpoint override mutated SDK catalog")
			}
		}
		return
	}
	t.Fatal("SDK fixture has no shared model IDs")
}

func TestConfigureProviderKeepsSelectionAndSupportsFirstConnection(t *testing.T) {
	dir := t.TempDir()
	s, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	before := s.Snapshot().Settings
	if err := s.ConfigureProvider(ProviderConnectionInput{Provider: "openai", APIKey: "new-provider-key"}); err != nil {
		t.Fatal(err)
	}
	st := s.Snapshot().Settings
	if st.Provider != before.Provider || st.Model != before.Model || st.ThinkingLevel != before.ThinkingLevel || st.HasAPIKey || !st.HasConnections {
		t.Fatalf("connection save changed selection or lost readiness: %+v", st)
	}
	catalog, err := s.Models("openai")
	if err != nil {
		t.Fatal(err)
	}
	var choice ProviderChoice
	for _, entry := range catalog.Providers {
		if entry.ID == "openai" {
			choice = entry
		}
	}
	if !choice.HasAPIKey || choice.BaseURL != "https://api.openai.com/v1" || choice.Model == "" {
		t.Fatalf("connection did not get SDK defaults: %+v", choice)
	}
	if err := s.SelectModel("openai", choice.Model, choice.ThinkingLevel); err != nil {
		t.Fatal(err)
	}
	selected := s.Snapshot().Settings
	if err := s.ConfigureProvider(ProviderConnectionInput{Provider: "deepseek", APIKey: "second-provider-key"}); err != nil {
		t.Fatal(err)
	}
	if got := s.Snapshot().Settings; got.Provider != selected.Provider || got.Model != selected.Model || got.ThinkingLevel != selected.ThinkingLevel || s.config.APIKey != "new-provider-key" {
		t.Fatal("adding a connection switched the active model")
	}
	if err := s.ConfigureProvider(ProviderConnectionInput{Provider: "openai", APIKey: "updated-key"}); err != nil {
		t.Fatal(err)
	}
	if s.config.APIKey != "updated-key" || s.Snapshot().Settings.Model != selected.Model {
		t.Fatal("active connection update did not preserve selection")
	}
	s.Close()
	reopened, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if reopened.config.APIKey != "updated-key" || reopened.Snapshot().Settings.Model != selected.Model {
		t.Fatal("connection and selection lost on restart")
	}
	if err := reopened.ConfigureProvider(ProviderConnectionInput{Provider: "deepseek", ClearAPIKey: true}); err != nil {
		t.Fatal(err)
	}
	if reopened.config.APIKey != "updated-key" || reopened.config.Connections["deepseek"].APIKey != "" {
		t.Fatal("removing another key changed the active credential")
	}
}

func TestProviderConnectionProbeUsesRememberedModelWithoutSavingOrSelecting(t *testing.T) {
	var gotModel atomic.Value
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		model, _ := body["model"].(string)
		gotModel.Store(model)
		if r.Header.Get("Authorization") != "Bearer probe-key" {
			t.Error("probe lost explicit credentials")
		}
		startSSE(w)
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"index": 0, "id": "probe", "type": "function", "function": map[string]any{"name": "connection_check", "arguments": `{"ok":true}`}}}}}}})
		finishSSE(w, "tool_calls")
	}))
	defer server.Close()
	s, _, dir := configuredService(t, server.URL)
	before, _ := os.ReadFile(filepath.Join(dir, "settings.json"))
	result, err := s.TestProviderConnection(context.Background(), ProviderConnectionInput{Provider: "deepseek", APIKey: "probe-key"})
	observed, _ := gotModel.Load().(string)
	if err != nil || !result.OK || observed != "deepseek-flash" || !strings.Contains(result.Message, observed) {
		t.Fatalf("provider probe failed: %+v %v", result, err)
	}
	after, _ := os.ReadFile(filepath.Join(dir, "settings.json"))
	if !bytes.Equal(before, after) {
		t.Fatal("probe saved configuration")
	}
	if err := s.ConfigureProvider(ProviderConnectionInput{Provider: "deepseek", BaseURL: server.URL + "/new"}); err != nil {
		t.Fatal(err)
	}
	if s.Snapshot().Settings.HasAPIKey || s.Snapshot().Settings.HasConnections {
		t.Fatal("provider key forwarded to a new address")
	}
}
