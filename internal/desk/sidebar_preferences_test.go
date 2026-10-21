package desk

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSidebarWidthsPersistWithoutLosingOtherSettings(t *testing.T) {
	s, _, dir := configuredService(t, "http://127.0.0.1:1")
	if err := s.SetSidebarWidths(SidebarWidths{340, 420}); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAppearance(AppearanceDark); err != nil {
		t.Fatal(err)
	}
	if err := s.Configure(ConfigInput{BaseURL: "http://127.0.0.1:2/v1", Model: "deepseek-v4-pro", APIKey: "fixture-private-key"}); err != nil {
		t.Fatal(err)
	}
	s.Close()
	reopened, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reopened.Close)
	settings := reopened.Snapshot().Settings
	if settings.NavigationWidth != 340 || settings.ToolsWidth != 420 || settings.Appearance != AppearanceDark || !settings.HasAPIKey {
		t.Fatalf("sidebar preferences or provider configuration lost: %+v", settings)
	}
	for _, widths := range []SidebarWidths{{0, 300}, {260, 0}, {-1, 300}, {260, 4097}} {
		if err := reopened.SetSidebarWidths(widths); err == nil {
			t.Fatal("invalid widths accepted")
		}
	}
	if settings := reopened.Snapshot().Settings; settings.NavigationWidth != 340 || settings.ToolsWidth != 420 {
		t.Fatal("invalid request changed widths")
	}
}

func TestSidebarSaveFailurePreservesThePreviousPreferencesAndCredentials(t *testing.T) {
	s, _, dir := configuredService(t, "http://127.0.0.1:1")
	if err := s.SetSidebarWidths(SidebarWidths{300, 400}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "settings.json")
	saved, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	if err = s.SetSidebarWidths(SidebarWidths{350, 500}); err == nil {
		t.Fatal("save unexpectedly succeeded")
	}
	settings := s.Snapshot().Settings
	if settings.NavigationWidth != 300 || settings.ToolsWidth != 400 || s.connections.config.APIKey != "fixture-private-key" {
		t.Fatal("failed save changed preferences or credentials")
	}
	if err = os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, saved, 0600); err != nil {
		t.Fatal(err)
	}
}
