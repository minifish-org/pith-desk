package host

import (
	"net/http"
	"strings"
	"testing"

	"github.com/minifish-org/pith-desk/internal/desk"
)

func TestDraftEndpointAcceptsWorstCaseJSONEscapingAtNewTextBoundary(t *testing.T) {
	s := testServer(t)
	w, err := s.service.AddWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	c, err := s.service.CreateConversation(w.ID)
	if err != nil {
		t.Fatal(err)
	}
	text := strings.Repeat("\x01", desk.MaxDraftBytes)
	status, body, _ := featureRequest(t, s, "POST", "/api/draft", map[string]any{"id": c.ID, "text": text, "revision": 1}, true)
	if status != http.StatusOK {
		t.Fatalf("48 MiB escaped draft was rejected: %d %.200s", status, body)
	}
	got, err := s.service.Draft(desk.DraftScope{ID: c.ID})
	if err != nil || got.Text != text {
		t.Fatal("large draft changed across HTTP/storage")
	}
	status, body, _ = featureRequest(t, s, "POST", "/api/draft", map[string]any{"id": c.ID, "text": text + "x", "revision": 2}, true)
	if status != 400 || !strings.Contains(body, "8 MiB") {
		t.Fatalf("draft overflow was not explained: %d %.200s", status, body)
	}
}

func TestLargeSendAndQueueDecodeButSmallConfigurationStillHasItsLimit(t *testing.T) {
	s := testServer(t)
	text := strings.Repeat("x", 33<<20)
	for _, path := range []string{"/api/send", "/api/queue"} {
		status, body, _ := featureRequest(t, s, "POST", path, map[string]string{"id": "missing", "text": text}, true)
		if status != 400 || strings.Contains(body, "request body too large") || strings.Contains(body, "unexpected EOF") {
			t.Fatalf("large message hit old body cap: %s %d %.200s", path, status, body)
		}
	}
	status, body, _ := featureRequest(t, s, "POST", "/api/rename", map[string]string{"id": "missing", "title": strings.Repeat("x", 3<<20)}, true)
	if status != 400 || !strings.Contains(body, "request body too large") {
		t.Fatalf("small config limit was lost: %d %.200s", status, body)
	}
}
