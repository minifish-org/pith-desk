package host

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/minifish-org/pith-desk/internal/wire"
)

func TestTypedMutationsReadAndRejectMalformedBodies(t *testing.T) {
	for _, mode := range []string{"desktop", "server"} {
		t.Run(mode, func(t *testing.T) {
			var s *Server
			var browser *serverBrowser
			if mode == "server" {
				s = testServerMode(t, "")
				browser = &serverBrowser{s: s}
				// Server pre-reads bodies; successful login/lease also verify their types.
				browser.login(t)
				browser.acquire(t, "", false)
			} else {
				s = testServer(t)
			}
			for _, endpoint := range wire.Endpoints {
				if endpoint.Method != http.MethodPost || endpoint.Input == nil || endpoint.Input.NumField() == 0 {
					continue
				}
				if mode == "desktop" && strings.HasPrefix(endpoint.Path, "/api/server/") {
					continue
				}
				t.Run(endpoint.Path, func(t *testing.T) {
					body := strings.NewReader("{")
					req := httptest.NewRequest(http.MethodPost, s.URL+endpoint.Path, body)
					req.Header.Set("Origin", s.URL)
					req.Header.Set("Content-Type", "application/json")
					if browser != nil {
						req.AddCookie(browser.cookie)
						req.Header.Set("X-Desk-Lease", browser.lease)
						req.Header.Set("X-Desk-Request", strconv.FormatUint(browser.seq.Add(1), 10))
					} else {
						req.Header.Set("Authorization", "Bearer "+s.token)
					}
					response := httptest.NewRecorder()
					s.serve(response, req)
					// A 400 before reading could hide a handler/registry type mismatch.
					if response.Code != http.StatusBadRequest || body.Len() != 0 {
						t.Fatalf("request was not decoded and rejected: status=%d unread=%d response=%s", response.Code, body.Len(), response.Body.String())
					}
				})
			}
		})
	}
}
