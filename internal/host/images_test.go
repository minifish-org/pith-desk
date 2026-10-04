package host

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/minifish-org/pith-desk/internal/desk"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
)

func TestImageUploadEndpointAndAuthenticatedHistory(t *testing.T) {
	requests := make(chan map[string]any, 1)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		requests <- body
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Image received\"}}]}\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer provider.Close()
	s := testServer(t)
	workspace, err := s.service.AddWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	conversation, err := s.service.CreateConversation(workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.service.Configure(desk.ConfigInput{BaseURL: provider.URL + "/v1", Model: "deepseek-flash", APIKey: "offline-image-key"}); err != nil {
		t.Fatal(err)
	}
	var pngBytes bytes.Buffer
	if err := png.Encode(&pngBytes, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	// PNG permits trailing bytes. Exercise an upload larger than the old 2 MiB JSON limit.
	data := append(pngBytes.Bytes(), make([]byte, 3<<20)...)
	img := aitypes.NewImageContent(base64.StdEncoding.EncodeToString(data), "image/png")
	payload := map[string]any{"text": "", "images": []aitypes.ImageContent{img}}
	if status, _, _ := featureRequest(t, s, "POST", "/api/send", payload, false); status != 401 {
		t.Fatal("unauthenticated upload accepted")
	}
	if status, body, _ := featureRequest(t, s, "POST", "/api/send", payload, true); status != 200 {
		t.Fatal("large image upload failed", status, body)
	}
	select {
	case <-requests:
	case <-time.After(30 * time.Second):
		t.Fatalf("image never reached provider: phase=%s error=%s", s.service.Snapshot().Runtime.Phase, s.service.Snapshot().Error)
	}
	deadline := time.Now().Add(30 * time.Second)
	for s.service.Snapshot().Running && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	st := s.service.Snapshot()
	if st.Running || st.Error != "" {
		t.Fatal("image run did not complete", st.Error)
	}
	if len(st.Messages) < 1 || len(st.Messages[0].Images) != 1 {
		t.Fatal("image-only message was lost")
	}
	path := "/api/image?" + url.Values{"id": {conversation.ID}, "message": {st.Messages[0].ID}, "index": {"0"}}.Encode()
	if status, _, _ := featureRequest(t, s, "GET", path, nil, false); status != 401 {
		t.Fatal("image leaked without authentication")
	}
	status, body, headers := featureRequest(t, s, "GET", path, nil, true)
	if status != 200 || !bytes.Equal([]byte(body), data) || headers.Get("Content-Type") != "image/png" || headers.Get("Cache-Control") != "no-store" {
		t.Fatal("history image response differed")
	}
	req, _ := http.NewRequest("GET", s.URL+path, nil)
	req.Header.Set("Authorization", "Bearer "+s.token)
	req.Header.Set("Origin", "https://other.example")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatal("cross-origin image accepted")
	}
	for _, bad := range []string{"/api/image?id=../settings&message=x&index=0", "/api/image?id=" + conversation.ID + "&message=x&index=-1", "/api/image?id=" + conversation.ID + "&message=x&index=abc"} {
		if status, _, _ := featureRequest(t, s, "GET", bad, nil, true); status != 404 {
			t.Fatal("unknown image not rejected", status)
		}
	}
	invalid := aitypes.NewImageContent(base64.StdEncoding.EncodeToString([]byte("<svg onload='alert(1)'/>")), "image/svg+xml")
	if status, _, _ := featureRequest(t, s, "POST", "/api/send", map[string]any{"images": []aitypes.ImageContent{invalid}}, true); status != 400 {
		t.Fatal("SVG upload accepted")
	}
	if status, body, _ := featureRequest(t, s, "GET", "/api/state", nil, true); status != 200 || strings.Contains(body, img.Data) {
		t.Fatal("state contains raw image bytes")
	}
}
