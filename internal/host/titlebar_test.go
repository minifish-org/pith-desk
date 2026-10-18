package host

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestTitlebarOverlayBootstrapFollowsOnlyTheWindowHost(t *testing.T) {
	s := testServer(t)
	for _, enabled := range []bool{false, true, false} {
		s.SetTitlebarOverlay(enabled)
		response, err := http.Get(s.URL)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		want := fmt.Sprintf(`<meta name="desk-titlebar-overlay" content="%t"`, enabled)
		if !strings.Contains(string(body), want) || strings.Contains(string(body), "__DESK_TITLEBAR_OVERLAY__") {
			t.Fatalf("titlebar capability did not follow the native host: enabled=%t", enabled)
		}
	}
}
