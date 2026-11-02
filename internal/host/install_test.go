package host

import (
	"bytes"
	"encoding/json"
	"image/png"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestServerWebAppInstallation(t *testing.T) {
	s := testServerMode(t, "")
	get := func(path string) (*http.Response, []byte) {
		t.Helper()
		resp, err := http.Get(s.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		data, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		return resp, data
	}
	_, index := get("/")
	if !bytes.Contains(index, []byte(`rel="manifest" href="/manifest.webmanifest"`)) {
		t.Fatal("Server entry does not advertise installation")
	}
	resp, data := get("/manifest.webmanifest")
	if resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "application/manifest+json") {
		t.Fatalf("manifest: %d %s", resp.StatusCode, resp.Header)
	}
	var manifest struct {
		ID, Name, Scope, Display string
		StartURL                 string `json:"start_url"`
		Icons                    []struct{ Src, Sizes, Type string }
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.ID != "/" || manifest.Name != "Pith Desk" || manifest.StartURL != "/" || manifest.Scope != "/" || manifest.Display != "standalone" || len(manifest.Icons) != 2 {
		t.Fatalf("unexpected manifest: %s", data)
	}
	for i, size := range []int{192, 512} {
		icon := manifest.Icons[i]
		resp, data = get(icon.Src)
		config, err := png.DecodeConfig(bytes.NewReader(data))
		if resp.StatusCode != 200 || err != nil || config.Width != size || config.Height != size {
			t.Fatalf("icon %s: %d %v %+v", icon.Src, resp.StatusCode, err, config)
		}
	}
	for _, path := range []string{"/manifest.webmanifest", "/icon-192.png", "/icon-512.png"} {
		req, _ := http.NewRequest("GET", s.URL+path, nil)
		req.Header.Set("Origin", "https://other.example")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 403 {
			t.Fatalf("foreign origin %s: %d", path, resp.StatusCode)
		}
	}
	resp, _ = get("/api/state")
	if resp.StatusCode != 401 {
		t.Fatalf("anonymous API: %d", resp.StatusCode)
	}
	desktop := testServer(t)
	resp, err := http.Get(desktop.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ = io.ReadAll(resp.Body)
	if bytes.Contains(data, []byte(`rel="manifest"`)) {
		t.Fatal("Desktop advertises web installation")
	}
}
