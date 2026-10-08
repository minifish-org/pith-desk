package desk

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	authtypes "github.com/minifish-org/pith/packages/ai/auth/types"
	"github.com/minifish-org/pith/packages/ai/catalog"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
)

func TestOpenAIReleaseCatalogAcrossRuntimePaths(t *testing.T) {
	for name, config := range map[string]savedConfig{
		"shared":    {},
		"signed-in": {AuthPath: filepath.Join(t.TempDir(), "auth.json")},
		"custom": {Connections: map[string]savedConnection{"custom-fixture": {
			API: aitypes.ApiOpenAICompletions, BaseURL: "http://127.0.0.1:1/v1",
			Models: []codingagent.ModelsJsonModel{{ID: "local"}},
		}}},
	} {
		t.Run(name, func(t *testing.T) {
			runtime, err := runtimeForConfig(config)
			if err != nil {
				t.Fatal(err)
			}
			for _, id := range []string{"openai", "openai-codex"} {
				for _, raw := range catalog.V1Models(id, "chat") {
					var expected aitypes.Model
					if err := json.Unmarshal(raw, &expected); err != nil {
						t.Fatal(err)
					}
					actual := runtime.GetModel(id, expected.Id)
					if actual == nil || !reflect.DeepEqual(*actual, expected) {
						t.Fatalf("%s/%s lost release metadata: %+v", id, expected.Id, actual)
					}
				}
				if runtime.GetModel(id, "gpt-6.1-sol") == nil {
					t.Fatalf("%s is missing GPT-6.1 Sol", id)
				}
			}
			if runtime.GetProvider("openai").Auth().APIKey == nil || runtime.GetProvider("openai-codex").Auth().OAuth == nil {
				t.Fatal("release catalog replaced native authentication")
			}
		})
	}
}

func TestGPT61CodexUsesSavedOAuthAndNativeAdapter(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	token := "fixture." + base64.RawURLEncoding.EncodeToString([]byte(`{"https://api.openai.com/auth":{"chatgpt_account_id":"fixture-account"}}`)) + ".fixture"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/codex/responses" || r.Header.Get("Authorization") != "Bearer "+token || r.Header.Get("ChatGPT-Account-ID") != "fixture-account" {
			t.Errorf("wrong Codex route or OAuth headers: %s", r.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body["model"] != "gpt-6.1-sol" {
			t.Errorf("wrong request model: %v", body["model"])
		}
		nativeFixture(w, aitypes.ApiOpenAIResponses, "gpt-6.1-sol", false)
	}))
	defer server.Close()
	config := savedConfig{AuthPath: filepath.Join(t.TempDir(), "auth.json"), Provider: "openai-codex", Model: "gpt-6.1-sol", BaseURL: server.URL,
		Connections: map[string]savedConnection{"openai-codex": {UseOAuth: true}}}
	_, err := codingagent.CreateAuthStorage(config.AuthPath).Modify(ctx, config.Provider, func(authtypes.Credential) (authtypes.Credential, error) {
		return authtypes.NewOAuthCredential("fixture-refresh", token, float64(time.Now().Add(time.Hour).UnixMilli())), nil
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	model, err := resolveConfiguredModel(config)
	if err != nil {
		t.Fatal(err)
	}
	stream, err := streamForConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	transport := aitypes.TransportSSE
	message, err := stream(model, aitypes.NewTranscriptContext([]aitypes.Message{aitypes.NewUserMessageVariant(aitypes.NewUserMessage("Hello", 1))}),
		&aitypes.SimpleStreamOptions{StreamOptions: aitypes.StreamOptions{Transport: &transport}}).Result(ctx)
	if err != nil || message.StopReason != aitypes.StopReasonStop || !strings.Contains(string(mustJSON(t, message)), "Native adapter works.") {
		t.Fatalf("Codex request failed: %+v, %v", message, err)
	}
}
