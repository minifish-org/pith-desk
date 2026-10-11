package desk

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image/color"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/minifish-org/pith/packages/durable"
	"github.com/minifish-org/pith/packages/durable/storage/jsonl"
)

type taskCrashReady struct {
	Window string `json:"window"`
	A      string `json:"a"`
	B      string `json:"b"`
	RunA   string `json:"runA"`
	RunB   string `json:"runB"`
}

func waitCrashMarker(t *testing.T, path string) {
	t.Helper()
	deadline := time.NewTimer(20 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(5 * time.Millisecond)
	defer tick.Stop()
	for {
		if _, err := os.Stat(path); err == nil {
			return
		}
		select {
		case <-tick.C:
		case <-deadline.C:
			t.Fatalf("crash marker missing: %s", filepath.Base(path))
		}
	}
}

// This is the actual Service/SDK worker. The parent kills it at the reported
// persisted window; no deferred Service.Close can run after SIGKILL.
func TestTaskCrashWorker(t *testing.T) {
	dir := os.Getenv("PITH_DESK_TASK_CRASH_DIR")
	if dir == "" {
		return
	}
	window := os.Getenv("PITH_DESK_TASK_CRASH_WINDOW")
	provider := os.Getenv("PITH_DESK_TASK_CRASH_PROVIDER")
	workspaceA, workspaceB := os.Getenv("PITH_DESK_TASK_CRASH_A"), os.Getenv("PITH_DESK_TASK_CRASH_B")
	s, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Configure(ConfigInput{BaseURL: provider + "/v1", Model: "deepseek-flash", APIKey: "fixture-private-key"}); err != nil {
		t.Fatal(err)
	}
	aWorkspace, err := s.AddWorkspace(workspaceA)
	if err != nil {
		t.Fatal(err)
	}
	a, err := s.CreateConversation(aWorkspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	bWorkspace, err := s.AddWorkspace(workspaceB)
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.CreateConversation(bWorkspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Send("Crash B"); err != nil {
		t.Fatal(err)
	}
	waitCrashMarker(t, filepath.Join(dir, "b-request-reached"))
	if err := s.QueueMessage(b.ID, "pending B", ""); err != nil {
		t.Fatal(err)
	}
	runB := s.Snapshot().Runtime.RunID
	if err := s.OpenConversation(a.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.SetPermissionMode(a.ID, PermissionWorkspaceWrite); err != nil {
		t.Fatal(err)
	}
	var readyOnce sync.Once
	emit := func(runID string) {
		readyOnce.Do(func() {
			data, _ := json.Marshal(taskCrashReady{Window: window, A: a.ID, B: b.ID, RunA: runID, RunB: runB})
			fmt.Fprintln(os.Stdout, string(data))
		})
	}
	s.journals.open = func(path string) (durable.Storage, error) {
		base, err := jsonl.Open(context.Background(), path, jsonl.Options{Fsync: true})
		if err != nil {
			return nil, err
		}
		probe := &journalWindow{Storage: base}
		if strings.HasSuffix(path, a.ID) {
			if window == "admission" {
				probe.after = func(_ context.Context, writes []durable.StorageWrite) error {
					for _, write := range writes {
						if write.Task != nil {
							var input durableInput
							json.Unmarshal(write.Task.Input, &input)
							if input.Text == "Crash A" {
								emit(input.RunID)
								select {}
							}
						}
					}
					return nil
				}
			}
			if window == "before-settlement" {
				probe.before = func(_ context.Context, writes []durable.StorageWrite) error {
					if journalSettles(writes) {
						for _, write := range writes {
							if write.Task != nil {
								var input durableInput
								json.Unmarshal(write.Task.Input, &input)
								emit(input.RunID)
							}
						}
						select {}
					}
					return nil
				}
			}
		}
		return probe, nil
	}
	if err := s.Send("Crash A"); err != nil {
		t.Fatal(err)
	}
	waitCrashMarker(t, filepath.Join(dir, "a-request-reached"))
	switch window {
	case "tool-effect":
		waitCrashMarker(t, filepath.Join(dir, "tool-result-reached"))
		emit(s.Snapshot().Runtime.RunID)
	case "queue-received":
		image := imageFixture(t, color.RGBA{R: 255, A: 255})
		if err := s.QueueMessage(a.ID, "pending A", "", image); err != nil {
			t.Fatal(err)
		}
		emit(s.Snapshot().Runtime.RunID)
	case "before-settlement":
	default:
		t.Fatalf("unknown crash window: %s", window)
	}
	select {}
}

func TestTaskSIGKILLWindowsRecoverWithoutReplayAndKeepConversationIdentity(t *testing.T) {
	for _, window := range []string{"admission", "tool-effect", "queue-received", "before-settlement"} {
		t.Run(window, func(t *testing.T) {
			root := t.TempDir()
			dir := filepath.Join(root, "private")
			workspaceA, workspaceB := filepath.Join(root, "a"), filepath.Join(root, "b")
			for _, path := range []string{workspaceA, workspaceB} {
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			}
			var callsA, callsB atomic.Int64
			var continued atomic.Bool
			continuedRequests := make(chan map[string]any, 8)
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					http.Error(w, "bad fixture request", 400)
					return
				}
				isB := countProviderUser(body, "Crash B") > 0
				if isB {
					callsB.Add(1)
					os.WriteFile(filepath.Join(dir, "b-request-reached"), []byte("ready"), 0600)
				} else {
					callsA.Add(1)
					os.WriteFile(filepath.Join(dir, "a-request-reached"), []byte("ready"), 0600)
				}
				startSSE(w)
				w.(http.Flusher).Flush()
				if continued.Load() {
					continuedRequests <- body
					sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": "Reviewed continuation complete"}}}})
					finishSSE(w, "stop")
					return
				}
				if !isB && window == "tool-effect" && callsA.Load() == 1 {
					sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"index": 0, "id": "crash-write", "type": "function", "function": map[string]any{"name": "write_file", "arguments": `{"path":"effect.txt","content":"one completed effect"}`}}}}}}})
					finishSSE(w, "tool_calls")
					return
				}
				if !isB && window == "tool-effect" {
					os.WriteFile(filepath.Join(dir, "tool-result-reached"), []byte("ready"), 0600)
				}
				if !isB && window == "before-settlement" {
					finishSSE(w, "stop")
					return
				}
				<-r.Context().Done()
			}))
			t.Cleanup(provider.Close)
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, executable, "-test.run=^TestTaskCrashWorker$", "-test.timeout=50s")
			command.Env = append(os.Environ(), "PITH_DESK_TASK_CRASH_DIR="+dir, "PITH_DESK_TASK_CRASH_WINDOW="+window, "PITH_DESK_TASK_CRASH_PROVIDER="+provider.URL, "PITH_DESK_TASK_CRASH_A="+workspaceA, "PITH_DESK_TASK_CRASH_B="+workspaceB)
			var stderr bytes.Buffer
			command.Stderr = &stderr
			stdout, err := command.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			if err := command.Start(); err != nil {
				t.Fatal(err)
			}
			defer func() { command.Process.Kill(); command.Wait() }()
			ready := make(chan taskCrashReady, 1)
			go func() {
				scanner := bufio.NewScanner(stdout)
				for scanner.Scan() {
					var message taskCrashReady
					if json.Unmarshal(scanner.Bytes(), &message) == nil && message.Window == window {
						ready <- message
						return
					}
				}
				ready <- taskCrashReady{}
			}()
			var ids taskCrashReady
			select {
			case ids = <-ready:
				if ids.A == "" || ids.B == "" || ids.RunA == "" || ids.RunB == "" {
					t.Fatalf("worker failed: %s", stderr.String())
				}
			case <-ctx.Done():
				t.Fatalf("worker did not reach %s: %s", window, stderr.String())
			}
			if err := command.Process.Kill(); err != nil {
				t.Fatal(err)
			}
			command.Wait()
			countA, countB := callsA.Load(), callsB.Load()
			reopened, err := New(dir)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(reopened.Close)
			for _, id := range []string{ids.A, ids.B} {
				if err := reopened.OpenConversation(id); err != nil {
					t.Fatal(err)
				}
				state := reopened.Snapshot()
				if state.Running || len(state.Runs) != 0 || state.Failure == nil || state.Failure.Kind != "interrupted" || state.Runtime.Phase != "interrupted" {
					t.Fatalf("crash recovered as completed/live: %+v", state)
				}
				for _, entry := range state.Conversations {
					if entry.ID == id && (entry.Unread || entry.CompletedRunID != "") {
						t.Fatal("unsettled task published completion")
					}
				}
				if id == ids.B {
					if len(state.QueuedMessages) != 1 || state.QueuedMessages[0].Text != "pending B" {
						t.Fatal("B recovery was mixed")
					}
				}
				if id == ids.A && window == "queue-received" {
					if len(state.QueuedMessages) != 1 || state.QueuedMessages[0].Text != "pending A" || state.QueuedMessages[0].ImageCount != 1 {
						t.Fatal("A queued input/attachment was lost")
					}
					reopened.mu.Lock()
					images := len(reopened.active.QueuedMessages[0].Images)
					reopened.mu.Unlock()
					if images != 1 {
						t.Fatal("persisted queue attachment was lost")
					}
				}
			}
			if callsA.Load() != countA || callsB.Load() != countB {
				t.Fatal("restart/navigation replayed old task")
			}
			if err := reopened.OpenConversation(ids.A); err != nil {
				t.Fatal(err)
			}
			continued.Store(true)
			if err := reopened.ContinueTask(ids.A); err != nil {
				t.Fatal(err)
			}
			request := receiveProviderRequest(t, continuedRequests)
			encoded, _ := json.Marshal(request["messages"])
			if !strings.Contains(string(encoded), "inspect the current workspace") || !strings.Contains(string(encoded), "Do not repeat completed writes") || !strings.Contains(string(encoded), "Crash A") {
				t.Fatalf("continuation lacked review/history: %s", encoded)
			}
			state := waitState(t, reopened, func(st State) bool { return !st.Running })
			if state.Runtime.RunID == ids.RunA || state.Error != "" {
				t.Fatalf("continuation reused old run or failed: %+v", state)
			}
			if window == "tool-effect" {
				data, err := os.ReadFile(filepath.Join(workspaceA, "effect.txt"))
				if err != nil || string(data) != "one completed effect" {
					t.Fatalf("completed effect changed: %q %v", data, err)
				}
			}
			if err := reopened.OpenConversation(ids.B); err != nil {
				t.Fatal(err)
			}
			state = reopened.Snapshot()
			if state.Runtime.RunID != ids.RunB || state.Failure == nil || state.Failure.Kind != "interrupted" || len(state.QueuedMessages) != 1 || callsB.Load() != countB {
				t.Fatal("A continuation changed B identity/input")
			}
		})
	}
}
