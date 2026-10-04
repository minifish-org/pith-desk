package host

import (
	"encoding/json"
	"github.com/minifish-org/pith-desk/internal/desk"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestModelCatalogAndSelectionRequireAuthAndNeverReturnProviderKeys(t *testing.T) {
	s := testServer(t)
	if err := s.service.Configure(desk.ConfigInput{BaseURL: "https://api.deepseek.com/v1", Model: "deepseek-flash", APIKey: "private-model-key"}); err != nil {
		t.Fatal(err)
	}
	send := func(method, path, body string, auth bool) (int, string) {
		t.Helper()
		r, _ := http.NewRequest(method, s.URL+path, strings.NewReader(body))
		if auth {
			r.Header.Set("Authorization", "Bearer "+s.token)
		}
		response, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		data, _ := io.ReadAll(response.Body)
		return response.StatusCode, string(data)
	}
	if code, _ := send("GET", "/api/models", "", false); code != 401 {
		t.Fatal("unauthenticated catalog accepted")
	}
	payload := `{"provider":"deepseek","model":"deepseek-flash","thinkingLevel":"max"}`
	if code, _ := send("POST", "/api/model-selection", payload, false); code != 401 {
		t.Fatal("unauthenticated selection accepted")
	}
	code, data := send("GET", "/api/models?provider=deepseek", "", true)
	if code != 200 || strings.Contains(data, "private-model-key") {
		t.Fatalf("unsafe catalog: %d", code)
	}
	var catalog desk.ModelCatalog
	if err := json.Unmarshal([]byte(data), &catalog); err != nil {
		t.Fatal(err)
	}
	for _, model := range catalog.Models {
		if model.Provider != "deepseek" {
			t.Fatal("provider filter ignored")
		}
	}
	if code, data = send("POST", "/api/model-selection", payload, true); code != 200 {
		t.Fatalf("selection failed: %d %s", code, data)
	}
	if st := s.service.Snapshot().Settings; st.ThinkingLevel != "max" || !st.HasAPIKey {
		t.Fatalf("selection lost credentials: %+v", st)
	}
	if code, _ = send("POST", "/api/model-selection", `{"provider":"deepseek","model":"deepseek-flash","thinkingLevel":"medium"}`, true); code != 400 {
		t.Fatal("invalid effort not rejected")
	}
}

func TestProviderConnectionEndpointDoesNotRequireOrSelectModel(t *testing.T) {
	s := testServer(t)
	before := s.service.Snapshot().Settings
	post := func(body string, auth bool) int {
		t.Helper()
		r, _ := http.NewRequest("POST", s.URL+"/api/provider-config", strings.NewReader(body))
		if auth {
			r.Header.Set("Authorization", "Bearer "+s.token)
		}
		response, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		return response.StatusCode
	}
	body := `{"provider":"openai","apiKey":"provider-only-fixture"}`
	if post(body, false) != 401 {
		t.Fatal("unauthenticated connection save accepted")
	}
	if post(body, true) != 200 {
		t.Fatal("connection required a model")
	}
	st := s.service.Snapshot().Settings
	if !st.HasConnections || st.HasAPIKey || st.Model != before.Model || st.Provider != before.Provider {
		t.Fatalf("connection changed selection: %+v", st)
	}
	if post(`{"provider":"openai","apiKey":"fixture","model":"arbitrary"}`, true) != 400 {
		t.Fatal("connection endpoint accepted a model selection")
	}
}
