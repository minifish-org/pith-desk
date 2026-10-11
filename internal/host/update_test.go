package host

import (
	"net/http"
	"strings"
	"testing"

	"github.com/minifish-org/pith-desk/internal/wire"
)

func TestUpdatesRequireAuthenticationAndStayDisabledInBrowserPreview(t *testing.T) {
	s := testServer(t)
	for _, method := range []string{"GET", "POST"} {
		req, _ := http.NewRequest(method, s.URL+"/api/update", strings.NewReader(`{"action":"install"}`))
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusUnauthorized {
			t.Fatal("unauthenticated updater request accepted")
		}
	}
	invoked := ""
	s.SetUpdateActions(func() wire.UpdateStatus { return wire.UpdateStatus{Enabled: true, Version: "0.1.0-rc.20"} }, func(action string) error { invoked = action; return nil })
	for _, body := range []string{`{"action":"install","url":"https://attacker.invalid/app"}`, `{"action":"install"}`} {
		req, _ := http.NewRequest("POST", s.URL+"/api/update", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+s.token)
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if strings.Contains(body, "url") {
			if response.StatusCode != 400 || invoked != "" {
				t.Fatal("page-controlled download URL accepted")
			}
		} else if response.StatusCode != 200 || invoked != "install" {
			t.Fatal("native update action was not invoked")
		}
	}
	s.SetUpdateActions(nil, nil)
	req, _ := http.NewRequest("POST", s.URL+"/api/update", strings.NewReader(`{"action":"install"}`))
	req.Header.Set("Authorization", "Bearer "+s.token)
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 400 {
		t.Fatal("browser preview installed an update")
	}
}
