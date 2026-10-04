package desk

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestAppearancePersistsWithoutLosingProviderConfiguration(t *testing.T) {
	s, _, dataDir := configuredService(t, "http://127.0.0.1:1")
	if s.Snapshot().Settings.Appearance != AppearanceSystem {
		t.Fatal("new settings did not follow system appearance")
	}
	if err := s.SetAppearance(AppearanceDark); err != nil {
		t.Fatal(err)
	}
	// Provider configuration must also retain the independently saved theme.
	if err := s.Configure(ConfigInput{BaseURL: "http://127.0.0.1:2/v1", Model: "deepseek-v4-pro", APIKey: "fixture-private-key"}); err != nil {
		t.Fatal(err)
	}
	s.Close()
	reopened, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reopened.Close)
	settings := reopened.Snapshot().Settings
	if settings.Appearance != AppearanceDark || settings.BaseURL != "http://127.0.0.1:2/v1" || settings.Model != "deepseek-v4-pro" || !settings.HasAPIKey {
		t.Fatalf("theme/provider settings were not retained: %+v", settings)
	}
	var saved savedConfig
	if err := readJSON(filepath.Join(dataDir, "settings.json"), &saved); err != nil {
		t.Fatal(err)
	}
	if saved.APIKey != "fixture-private-key" || saved.Appearance != AppearanceDark {
		t.Fatal("saving appearance or provider configuration erased the API key")
	}
}

func TestLegacyAppearanceDefaultsToSystemWithoutRewritingSettings(t *testing.T) {
	for _, preference := range []string{"", `,"appearance":""`, `,"appearance":"unsupported"`} {
		t.Run(preference, func(t *testing.T) {
			dataDir := t.TempDir()
			path := filepath.Join(dataDir, "settings.json")
			legacy := []byte(`{"baseUrl":"https://api.deepseek.com/v1","model":"deepseek-flash","apiKey":"legacy-private-key"` + preference + `}`)
			if err := os.WriteFile(path, legacy, 0600); err != nil {
				t.Fatal(err)
			}
			s, err := New(dataDir)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(s.Close)
			if settings := s.Snapshot().Settings; settings.Appearance != AppearanceSystem || !settings.HasAPIKey {
				t.Fatalf("legacy preference did not safely default: %+v", settings)
			}
			if err := s.SetAppearance(AppearanceMode("invalid")); err == nil {
				t.Fatal("invalid appearance was accepted")
			}
			stored, err := os.ReadFile(path)
			if err != nil || !bytes.Equal(stored, legacy) {
				t.Fatal("loading an old preference or rejecting an invalid choice rewrote settings")
			}
		})
	}
}

func TestAppearanceSaveFailureKeepsPreviousPreferenceAndCredentials(t *testing.T) {
	s, _, dataDir := configuredService(t, "http://127.0.0.1:1")
	if err := s.SetAppearance(AppearanceLight); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dataDir, "settings.json")
	saved, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAppearance(AppearanceDark); err == nil {
		t.Fatal("appearance succeeded even though settings could not be saved")
	}
	if settings := s.Snapshot().Settings; settings.Appearance != AppearanceLight || !settings.HasAPIKey {
		t.Fatal("failed appearance save altered public settings")
	}
	if s.config.APIKey != "fixture-private-key" {
		t.Fatal("failed appearance save altered credentials")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, saved, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestAppearanceCanChangeDuringActiveProviderRun(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture-private-key" {
			t.Error("provider credential changed")
		}
		startSSE(w)
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": "Working"}}}})
		<-r.Context().Done()
	}))
	t.Cleanup(server.Close)
	s, _, dataDir := configuredService(t, server.URL)
	if err := s.Send("Start a task"); err != nil {
		t.Fatal(err)
	}
	waitState(t, s, func(st State) bool { return st.Running && countText(st.Messages, "Working") == 1 })
	if err := s.SetAppearance(AppearanceDark); err != nil {
		t.Fatalf("appearance could not change during a task: %v", err)
	}
	if state := s.Snapshot(); !state.Running || state.Settings.Appearance != AppearanceDark || !state.Settings.HasAPIKey {
		t.Fatalf("appearance update disrupted the active task: %+v", state)
	}
	s.Abort()
	waitState(t, s, func(st State) bool { return !st.Running })
	s.Close()
	reopened, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reopened.Close)
	if reopened.Snapshot().Settings.Appearance != AppearanceDark {
		t.Fatal("appearance selected during a task did not survive restart")
	}
}
