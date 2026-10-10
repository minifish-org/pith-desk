package host

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/minifish-org/pith-desk/internal/desk"
)

func TestDevelopmentHostKeepsAuthenticationOriginAndFreshIndex(t *testing.T) {
	var version atomic.Int32
	version.Store(1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			io.WriteString(w, `<meta name="desk-token" content="__DESK_TOKEN__"><html data-appearance="__DESK_APPEARANCE__">`)
			if version.Load() == 2 {
				io.WriteString(w, "updated")
			}
			return
		}
		io.WriteString(w, "development module")
	}))
	defer upstream.Close()
	service, err := desk.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	s, err := StartDevelopment(service, nil, upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for _, tc := range []struct {
		path, origin, credential string
		want                     int
	}{
		{"/", "", "", 200},
		{"/src/main.ts", "", "", 200},
		{"/src/main.ts", "https://other.test", "", 403},
		{"/__desk_hmr", "https://other.test", "", 403},
		{"/api/state", "", "", 401},
		{"/api/state", "", s.token, 200},
		{"/api/state", "https://other.test", s.token, 403},
		{"/@fs/etc/passwd", "", "", 404},
		{"/workspace/notes.md", "", "", 404},
	} {
		req, _ := http.NewRequest(http.MethodGet, s.URL+tc.path, nil)
		req.Header.Set("Origin", tc.origin)
		if tc.credential != "" {
			req.Header.Set("Authorization", "Bearer "+tc.credential)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != tc.want {
			t.Fatalf("%s: %d want %d: %s", tc.path, resp.StatusCode, tc.want, body)
		}
		if tc.path == "/" && (!strings.Contains(string(body), s.token) || strings.Contains(string(body), "__DESK_TOKEN__")) {
			t.Fatal("development index did not bootstrap its own credential")
		}
		if tc.want == 200 && !strings.Contains(resp.Header.Get("Content-Security-Policy"), "frame-ancestors 'none'") {
			t.Fatal("development lost host policy")
		}
	}
	version.Store(2)
	resp, err := http.Get(s.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "updated") || resp.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("development index was stale or cacheable")
	}
	// A normal host cannot expose development source routes.
	production := testServer(t)
	resp2, err := http.Get(production.URL + "/src/main.ts")
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != 404 {
		t.Fatal("production enabled development routes")
	}
}

func TestDevelopmentFrontendRequiresExactLoopbackOrigin(t *testing.T) {
	for _, target := range []string{"https://127.0.0.1:1234", "http://localhost:1234", "http://127.0.0.1", "http://127.0.0.1:0", "http://127.0.0.1:99999", "http://user@127.0.0.1:1234", "http://127.0.0.1:1234/src/", "http://127.0.0.1:1234?key=x", "http://127.0.0.1:1234#x", "http://example.com:1234"} {
		if s, err := StartDevelopment(nil, nil, target); err == nil {
			s.Close()
			t.Fatalf("accepted frontend origin %q", target)
		}
	}
}
