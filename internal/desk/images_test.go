package desk

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	aitypes "github.com/minifish-org/pith/packages/ai/types"
)

func imageFixture(t *testing.T, c color.Color) aitypes.ImageContent {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	img.Set(0, 0, c)
	var data bytes.Buffer
	if err := png.Encode(&data, img); err != nil {
		t.Fatal(err)
	}
	return aitypes.NewImageContent(base64.StdEncoding.EncodeToString(data.Bytes()), "image/png")
}

func configureVision(t *testing.T, s *Service, url string) {
	t.Helper()
	if err := s.Configure(ConfigInput{BaseURL: url + "/v1", Model: "deepseek-flash", APIKey: "fixture-private-key"}); err != nil {
		t.Fatal(err)
	}
	if !s.Snapshot().Settings.SupportsImages {
		t.Fatal("catalog vision capability missing")
	}
}

func providerImageURLs(body map[string]any) []string {
	var out []string
	for _, raw := range body["messages"].([]any) {
		msg := raw.(map[string]any)
		if content, ok := msg["content"].([]any); ok {
			for _, raw := range content {
				block := raw.(map[string]any)
				if u, ok := block["image_url"].(map[string]any); ok {
					out = append(out, u["url"].(string))
				}
			}
		}
	}
	return out
}

func TestImagePromptQueueHistoryAndRestart(t *testing.T) {
	requests := make(chan map[string]any, 5)
	firstFinish, secondFinish := make(chan struct{}), make(chan struct{})
	var firstOnce, secondOnce sync.Once
	t.Cleanup(func() { firstOnce.Do(func() { close(firstFinish) }); secondOnce.Do(func() { close(secondFinish) }) })
	var count atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		requests <- body
		startSSE(w)
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": "Image received"}}}})
		n := count.Add(1)
		if n <= 2 {
			finish := firstFinish
			if n == 2 {
				finish = secondFinish
			}
			select {
			case <-finish:
			case <-r.Context().Done():
				return
			}
		}
		finishSSE(w, "stop")
	}))
	t.Cleanup(provider.Close)
	s, _, data := configuredService(t, provider.URL)
	configureVision(t, s, provider.URL)
	red := imageFixture(t, color.RGBA{R: 255, A: 255})
	blue := imageFixture(t, color.RGBA{B: 255, A: 255})
	if err := s.Send("", red); err != nil {
		t.Fatal(err)
	}
	first := receiveProviderRequest(t, requests)
	if urls := providerImageURLs(first); len(urls) != 1 || urls[0] != "data:image/png;base64,"+red.Data {
		t.Fatal("SDK image was not delivered intact")
	}
	id := s.Snapshot().ActiveID
	if err := s.QueueMessage(id, "same text", QueueFollowUp, blue); err != nil {
		t.Fatal(err)
	}
	if err := s.QueueMessage(id, "same text", QueueSteer, red); err != nil {
		t.Fatal(err)
	}
	queued := s.Snapshot()
	queued.QueuedMessages[0].Images[0].Data = "mutated"
	if s.Snapshot().QueuedMessages[0].Images[0].Data != blue.Data {
		t.Fatal("snapshot exposed mutable queue")
	}
	raw, _ := json.Marshal(s.Snapshot())
	if bytes.Contains(raw, []byte(red.Data)) || bytes.Contains(raw, []byte(blue.Data)) {
		t.Fatal("streaming state contains image bytes")
	}
	firstOnce.Do(func() { close(firstFinish) })
	second := receiveProviderRequest(t, requests)
	urls := providerImageURLs(second)
	if len(urls) != 2 || urls[1] != "data:image/png;base64,"+red.Data {
		t.Fatalf("steering image lost: %v", urls)
	}
	waitState(t, s, func(st State) bool { return len(st.QueuedMessages) == 1 && st.QueuedMessages[0].Mode == QueueFollowUp })
	secondOnce.Do(func() { close(secondFinish) })
	third := receiveProviderRequest(t, requests)
	urls = providerImageURLs(third)
	if len(urls) != 3 || urls[2] != "data:image/png;base64,"+blue.Data {
		t.Fatal("follow-up image lost or duplicated")
	}
	st := waitState(t, s, func(st State) bool { return !st.Running })
	if st.Error != "" || len(st.QueuedMessages) != 0 {
		t.Fatalf("image run failed: %s", st.Error)
	}
	if st.Conversations[0].Title != "Image conversation" {
		t.Fatal("image-only title missing")
	}
	imageMessages := 0
	for _, m := range st.Messages {
		if len(m.Images) == 0 {
			continue
		}
		imageMessages++
		b, mime, err := s.ConversationImage(id, m.ID, 0)
		if err != nil || mime != "image/png" || len(b) == 0 {
			t.Fatal("history image unreadable", err)
		}
	}
	diagnostics, err := s.Diagnostics()
	if err != nil || strings.Contains(diagnostics, red.Data) || strings.Contains(diagnostics, blue.Data) {
		t.Fatal("diagnostics leaked image bytes", err)
	}
	if imageMessages != 3 {
		t.Fatalf("want 3 image messages, got %d", imageMessages)
	}
	st.Messages[0].Images[0].MimeType = "changed"
	if s.Snapshot().Messages[0].Images[0].MimeType != "image/png" {
		t.Fatal("message image snapshot aliases state")
	}
	s.Close()
	reopened, err := New(data)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reopened.Close)
	restored := reopened.Snapshot()
	if len(restored.Messages[0].Images) != 1 {
		t.Fatal("image-only history disappeared on reopen")
	}
	bytes, mime, err := reopened.ConversationImage(id, restored.Messages[0].ID, 0)
	if err != nil || mime != "image/png" || base64.StdEncoding.EncodeToString(bytes) != red.Data {
		t.Fatal("reopened image differs", err)
	}
	markdown, err := reopened.ExportConversation(id)
	if err != nil || !strings.Contains(markdown, "image attachment(s)") || strings.Contains(markdown, red.Data) {
		t.Fatal("Markdown silently lost images or exported raw bytes")
	}
	if err := reopened.Send("continue"); err != nil {
		t.Fatal(err)
	}
	resumed := receiveProviderRequest(t, requests)
	if len(providerImageURLs(resumed)) != 3 {
		t.Fatal("image history not included after restart")
	}
	waitState(t, reopened, func(st State) bool { return !st.Running })
	if _, _, err := reopened.ConversationImage("../settings", restored.Messages[0].ID, 0); err == nil {
		t.Fatal("unknown conversation accepted")
	}
	if _, _, err := reopened.ConversationImage(id, "missing", 0); err == nil {
		t.Fatal("unknown message accepted")
	}
}

func TestImageValidationAndWorkspaceRead(t *testing.T) {
	s, folder, _ := configuredService(t, "http://127.0.0.1:1")
	pic := imageFixture(t, color.Black)
	if err := s.Configure(ConfigInput{BaseURL: "http://127.0.0.1:1/v1", Model: "deepseek-v4-pro", APIKey: "fixture-private-key"}); err != nil {
		t.Fatal(err)
	}
	before := s.Snapshot()
	if err := s.Send("image", pic); err == nil || !strings.Contains(err.Error(), "does not support images") {
		t.Fatal("text model accepted image", err)
	}
	if s.Snapshot().Running || s.Snapshot().Conversations[0] != before.Conversations[0] {
		t.Fatal("invalid upload changed state")
	}
	configureVision(t, s, "http://127.0.0.1:1")
	model, _ := resolveModel("deepseek-flash", "http://127.0.0.1:1/v1")
	for _, invalid := range []aitypes.ImageContent{
		aitypes.NewImageContent("not base64", "image/png"),
		aitypes.NewImageContent(pic.Data, "image/jpeg"),
		aitypes.NewImageContent(base64.StdEncoding.EncodeToString([]byte("<svg/>")), "image/svg+xml"),
		aitypes.NewImageContent(strings.Repeat("A", base64.StdEncoding.EncodedLen(MaxImageUploadBytes)+4), "image/png"),
	} {
		if _, err := validateImages([]aitypes.ImageContent{invalid}, model); err == nil {
			t.Fatal("invalid image accepted")
		}
	}
	raw, _ := base64.StdEncoding.DecodeString(pic.Data)
	if err := os.WriteFile(folder+"/image.png", raw, 0600); err != nil {
		t.Fatal(err)
	}
	policy, err := newFilePolicy(folder, s.dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer policy.root.Close()
	if _, _, err := policy.DetectImageMimeType(policy.path + "/image.png"); err == nil {
		t.Fatal("text model policy accepted image")
	}
	policy.allowImages = true
	if mime, ok, err := policy.DetectImageMimeType(policy.path + "/image.png"); err != nil || !ok || mime != "image/png" {
		t.Fatal("guarded image reader failed", err)
	}
	if _, _, err := policy.DetectImageMimeType(s.dataDir + "/settings.json"); err == nil {
		t.Fatal("image support escaped private data boundary")
	}
}

func TestPendingImageIsNotRedispatchedOnSDKRetry(t *testing.T) {
	requests := make(chan map[string]any, 4)
	releaseFailure := make(chan struct{})
	var releaseOnce sync.Once
	t.Cleanup(func() { releaseOnce.Do(func() { close(releaseFailure) }) })
	var count atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		requests <- body
		if count.Add(1) == 1 {
			select {
			case <-releaseFailure:
			case <-r.Context().Done():
				return
			}
			http.Error(w, `{"error":{"message":"temporary server error"}}`, http.StatusServiceUnavailable)
			return
		}
		startSSE(w)
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": "done"}}}})
		finishSSE(w, "stop")
	}))
	t.Cleanup(provider.Close)
	s, _, _ := configuredService(t, provider.URL)
	first := imageFixture(t, color.White)
	queued := imageFixture(t, color.Black)
	if err := s.Send("start", first); err != nil {
		t.Fatal(err)
	}
	receiveProviderRequest(t, requests)
	if err := s.QueueMessage(s.Snapshot().ActiveID, "queued image", QueueFollowUp, queued); err != nil {
		t.Fatal(err)
	}
	releaseOnce.Do(func() { close(releaseFailure) })
	receiveProviderRequest(t, requests) // Retry of the first model turn.
	final := receiveProviderRequest(t, requests)
	urls := providerImageURLs(final)
	if len(urls) != 2 || urls[1] != "data:image/png;base64,"+queued.Data {
		t.Fatal("pending image was lost or redispatched during retry")
	}
	st := waitState(t, s, func(st State) bool { return !st.Running })
	if st.Error != "" || len(st.QueuedMessages) != 0 || count.Load() != 3 {
		t.Fatal("retry queue did not settle exactly once", st.Error, count.Load())
	}
}
