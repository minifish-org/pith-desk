package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/egoist/mygo"
	"github.com/minifish-org/pith-desk/internal/desk"
	"github.com/minifish-org/pith-desk/internal/host"
)

func TestConversationFileLinkNativeSaveCancellationAndFailure(t *testing.T) {
	if os.Getenv("PITH_DESK_NATIVE_SMOKE") != "1" {
		t.Skip("set PITH_DESK_NATIVE_SMOKE=1 for native file-link verification")
	}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		chunk, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]string{"role": "assistant", "content": "[Download document](output/报告%20v1.docx)"}}}})
		fmt.Fprintf(w, "data: %s\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n", chunk)
	}))
	defer provider.Close()
	service, err := desk.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	workspace, err := service.AddWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	conversation, err := service.CreateConversation(workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.Configure(desk.ConfigInput{BaseURL: provider.URL + "/v1", Model: "deepseek-flash", APIKey: "fixture-key"}); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(workspace.Path, "output"), 0700); err != nil {
		t.Fatal(err)
	}
	content := []byte{'P', 'K', 3, 4, 0, 255}
	if err := os.WriteFile(filepath.Join(workspace.Path, "output", "报告 v1.docx"), content, 0600); err != nil {
		t.Fatal(err)
	}
	server, err := host.Start(service, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	destination := filepath.Join(t.TempDir(), "saved.docx")
	var saves, automaticDownloads atomic.Int32
	server.SetFileDownloadAction(func(name string, source io.Reader) error {
		if name != "报告 v1.docx" {
			return fmt.Errorf("unexpected filename %q", name)
		}
		switch saves.Add(1) {
		case 1:
			return saveDownloadedFile(destination, source)
		case 2:
			return nil // Native cancellation.
		default:
			return errors.New("Fixture native save failed")
		}
	})
	var win *mygo.Window
	mygo.RunOnMain(func() {
		win = mygo.NewWindow(mygo.WindowOptions{Title: "Pith Desk download smoke", Hidden: true, Width: 1320, Height: 860})
		win.Page().OnWillDownload(func(e *mygo.DownloadEvent) { automaticDownloads.Add(1); e.PreventDefault() })
	})
	defer win.Destroy()
	if err := win.Page().LoadURL(server.URL); err != nil {
		t.Fatal(err)
	}
	if err := service.SendConversation(conversation.ID, "Provide a document link"); err != nil {
		t.Fatal(err)
	}
	waitNativeDropCondition(t, win, `document.querySelector('a[data-download-path]')?.dataset.downloadPath === 'output/报告 v1.docx' && document.querySelector('a[data-download-path]').getAttribute('aria-disabled') === 'false'`)
	if nativeDropEval(t, win, `document.querySelector('#artifacts-control').hidden`) != true {
		t.Fatal("unrecorded shell file entered the artifact list")
	}
	for attempt := range 3 {
		nativeDropEval(t, win, `document.querySelector('a[data-download-path]').click(); return true;`)
		waitNativeDropCondition(t, win, `document.querySelector('a[data-download-path]').getAttribute('aria-disabled') === 'false'`)
		if saves.Load() != int32(attempt+1) {
			t.Fatalf("save request count: %d", saves.Load())
		}
	}
	waitNativeDropCondition(t, win, `document.querySelector('#inline-error').textContent.includes('Fixture native save failed')`)
	data, err := os.ReadFile(destination)
	if err != nil || !bytes.Equal(data, content) {
		t.Fatalf("native save bytes changed: %q %v", data, err)
	}
	if automaticDownloads.Load() != 0 {
		t.Fatal("native cancellation or failure started a browser download")
	}
}
