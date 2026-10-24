//go:build darwin || linux

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/egoist/mygo"
	"github.com/minifish-org/pith-desk/internal/desk"
	"github.com/minifish-org/pith-desk/internal/host"
)

func TestDesktopFileSavesPreserveExistingFilesOnWriteFailure(t *testing.T) {
	// A file-size limit belongs to this disposable process, never the app or other tests.
	if os.Getenv("PITH_DESK_FILE_SAVE_FAILURE") != "1" {
		executable, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, executable, "-test.run=^TestDesktopFileSavesPreserveExistingFilesOnWriteFailure$", "-test.v")
		command.Env = append(os.Environ(), "PITH_DESK_FILE_SAVE_FAILURE=1", "PITH_DESK_NATIVE_SMOKE=0")
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("save failure subprocess: %v\n%s", err, output)
		}
		return
	}
	signal.Ignore(syscall.SIGXFSZ)
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
	server, err := host.Start(service, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	response, err := http.Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	index, err := io.ReadAll(response.Body)
	response.Body.Close()
	token := regexp.MustCompile(`name="desk-token" content="([^"]+)"`).FindSubmatch(index)
	if err != nil || len(token) != 2 {
		t.Fatalf("desktop bootstrap credential: %v", err)
	}
	post := func(endpoint string) (int, string) {
		t.Helper()
		payload, _ := json.Marshal(map[string]string{"id": conversation.ID})
		if endpoint == "/api/diagnostics" {
			payload = []byte("{}")
		}
		request, _ := http.NewRequest(http.MethodPost, server.URL+endpoint, bytes.NewReader(payload))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Authorization", "Bearer "+string(token[1]))
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		return response.StatusCode, string(body)
	}
	for _, endpoint := range []string{"/api/export", "/api/diagnostics"} {
		t.Run(filepath.Base(endpoint), func(t *testing.T) {
			folder := t.TempDir()
			path := filepath.Join(folder, "existing.txt")
			original := []byte(strings.Repeat("Keep the existing document.\n", 20))
			if err := os.WriteFile(path, original, 0600); err != nil {
				t.Fatal(err)
			}
			var dialogMu sync.Mutex
			installFileSaves(server, func() *mygo.Window { return nil }, &dialogMu, func(options mygo.SaveDialogOptions) (string, error) {
				if !options.CreateDirectories || len(options.Filters) != 1 {
					t.Error("native text save lost its dialog options")
				}
				return path, nil
			})
			var previous syscall.Rlimit
			if err := syscall.Getrlimit(syscall.RLIMIT_FSIZE, &previous); err != nil {
				t.Fatal(err)
			}
			limit := previous
			limit.Cur = 32
			if err := syscall.Setrlimit(syscall.RLIMIT_FSIZE, &limit); err != nil {
				t.Fatal(err)
			}
			status, body := post(endpoint)
			if err := syscall.Setrlimit(syscall.RLIMIT_FSIZE, &previous); err != nil {
				t.Fatal(err)
			}
			if status != http.StatusBadRequest || !strings.Contains(body, syscall.EFBIG.Error()) {
				t.Fatalf("actual write failure was not reported: %d %s", status, body)
			}
			data, err := os.ReadFile(path)
			if err != nil || !bytes.Equal(data, original) {
				t.Fatalf("failed %s destroyed the existing file: %d bytes, %v", endpoint, len(data), err)
			}
			entries, err := os.ReadDir(folder)
			if err != nil || len(entries) != 1 {
				t.Fatalf("failed save left temporary files: %v %v", entries, err)
			}
			if status, body := post(endpoint); status != 200 || !strings.Contains(body, `"native":true`) {
				t.Fatalf("retry failed: %d %s", status, body)
			}
			saved, err := os.ReadFile(path)
			if err != nil || len(saved) <= 32 || endpoint == "/api/diagnostics" && !json.Valid(saved) || endpoint == "/api/export" && !bytes.HasPrefix(saved, []byte("# New conversation")) {
				t.Fatalf("retry did not save complete content: %q %v", saved, err)
			}
			for _, dialogError := range []error{nil, errors.New("save dialog unavailable")} {
				installFileSaves(server, func() *mygo.Window { return nil }, &dialogMu, func(mygo.SaveDialogOptions) (string, error) { return "", dialogError })
				status, body := post(endpoint)
				if dialogError == nil && (status != 200 || !strings.Contains(body, `"native":true`)) || dialogError != nil && (status != 400 || !strings.Contains(body, dialogError.Error())) {
					t.Fatalf("cancel/dialog failure changed semantics: %d %s", status, body)
				}
				if data, err := os.ReadFile(path); err != nil || !bytes.Equal(data, saved) {
					t.Fatal("cancel/dialog failure changed the existing file")
				}
			}
		})
	}
}
