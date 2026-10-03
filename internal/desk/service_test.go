package desk

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
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

	agenttypes "github.com/minifish-org/pith/packages/agent/types"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
)

func TestProviderApprovalStreamingAndJSONLResume(t *testing.T) {
	var requests atomic.Int32
	finishStreaming := make(chan struct{})
	var finishOnce sync.Once
	t.Cleanup(func() { finishOnce.Do(func() { close(finishStreaming) }) })
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if r.Header.Get("Authorization") != "Bearer fixture-private-key" {
			t.Error("the Pith adapter did not receive the saved credential")
		}
		if body["model"] != "deepseek-flash" || body["max_tokens"] != float64(384000) {
			t.Errorf("model capacity was not preserved: %v / %v", body["model"], body["max_tokens"])
		}
		startSSE(w)
		switch requests.Add(1) {
		case 1:
			sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{
				"role": "assistant", "tool_calls": []any{map[string]any{"index": 0, "id": "write-note", "type": "function", "function": map[string]any{
					"name": "write_file", "arguments": `{"path":"note.txt","content":"Hello from Pith Desk"}`,
				}}},
			}}}})
			finishSSE(w, "tool_calls")
		case 2:
			sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": "Saved "}}}})
			select {
			case <-finishStreaming:
			case <-r.Context().Done():
				return
			}
			sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": "note.txt."}}}})
			finishSSE(w, "stop")
		default:
			encoded, _ := json.Marshal(body["messages"])
			if !strings.Contains(string(encoded), "Hello from Pith Desk") || !strings.Contains(string(encoded), "Saved note.txt.") {
				t.Errorf("the reopened Pith session lost its prior transcript: %s", encoded)
			}
			sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": "The note is still here."}}}})
			finishSSE(w, "stop")
		}
	}))
	t.Cleanup(server.Close)
	s, folder, dataDir := configuredService(t, server.URL)
	if err := s.Send("Create a note"); err != nil {
		t.Fatal(err)
	}
	state := waitState(t, s, func(st State) bool { return st.PendingApproval != nil })
	if state.PendingApproval.ToolName != "write_file" || !state.Running {
		t.Fatalf("wrong approval state: %+v", state)
	}
	if _, err := os.Stat(filepath.Join(folder, "note.txt")); !os.IsNotExist(err) {
		t.Fatal("the write ran before approval")
	}
	if err := s.Configure(ConfigInput{BaseURL: server.URL + "/v1", Model: "deepseek-flash"}); err == nil {
		t.Fatal("settings changed during an active run")
	}
	approvalID := state.PendingApproval.ID
	if err := s.DecideApproval(approvalID, true); err != nil {
		t.Fatal(err)
	}
	if err := s.DecideApproval(approvalID, true); err == nil {
		t.Fatal("duplicate approval was accepted")
	}
	waitState(t, s, func(st State) bool {
		for _, message := range st.Messages {
			if message.Status == "streaming" && message.Text == "Saved " {
				return true
			}
		}
		return false
	})
	finishOnce.Do(func() { close(finishStreaming) })
	state = waitState(t, s, func(st State) bool { return !st.Running })
	if state.Error != "" {
		t.Fatal(state.Error)
	}
	if bytes, err := os.ReadFile(filepath.Join(folder, "note.txt")); err != nil || string(bytes) != "Hello from Pith Desk" {
		t.Fatalf("approved write missing: %s, %v", bytes, err)
	}
	if countText(state.Messages, "Saved note.txt.") != 1 {
		t.Fatalf("streaming and persisted text were duplicated: %+v", state.Messages)
	}
	s.Close()
	reopened, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reopened.Close)
	if !reopened.Snapshot().Settings.HasAPIKey || countText(reopened.Snapshot().Messages, "Saved note.txt.") != 1 {
		t.Fatalf("settings or messages were not restored: %+v", reopened.Snapshot())
	}
	if err := reopened.Send("Is my note still there?"); err != nil {
		t.Fatal(err)
	}
	state = waitState(t, reopened, func(st State) bool { return !st.Running })
	if state.Error != "" || countText(state.Messages, "The note is still here.") != 1 {
		t.Fatalf("resumed run failed: %+v", state)
	}
	public, _ := json.Marshal(state)
	if strings.Contains(string(public), "fixture-private-key") || strings.Contains(string(public), `"apiKey"`) {
		t.Fatal("the API key leaked into the UI snapshot")
	}
	for _, path := range []string{"settings.json", "catalog.json", filepath.Join("sessions", state.ActiveID+".jsonl")} {
		info, err := os.Stat(filepath.Join(dataDir, path))
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatalf("application file isn't private: %s, %v", path, err)
		}
	}
}

func TestAbortWhileApprovalPendingPreventsWrite(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		startSSE(w)
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{
			"role": "assistant", "tool_calls": []any{map[string]any{"index": 0, "id": "cancel-write", "type": "function", "function": map[string]any{
				"name": "write_file", "arguments": `{"path":"should-not-exist.txt","content":"unapproved"}`,
			}}},
		}}}})
		finishSSE(w, "tool_calls")
	}))
	t.Cleanup(server.Close)
	s, folder, _ := configuredService(t, server.URL)
	if err := s.Send("Write a file"); err != nil {
		t.Fatal(err)
	}
	state := waitState(t, s, func(st State) bool { return st.PendingApproval != nil })
	approvalID := state.PendingApproval.ID
	s.Abort()
	state = waitState(t, s, func(st State) bool { return !st.Running })
	if state.PendingApproval != nil || state.Error != "" {
		t.Fatalf("cancellation left a pending approval or provider error: %+v", state)
	}
	if err := s.DecideApproval(approvalID, true); err == nil {
		t.Fatal("a canceled action could still be approved")
	}
	if _, err := os.Stat(filepath.Join(folder, "should-not-exist.txt")); !os.IsNotExist(err) {
		t.Fatal("cancellation executed the unapproved action")
	}
}

func TestAbortCancelsStreamingProvider(t *testing.T) {
	canceled := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		startSSE(w)
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": "Working"}}}})
		<-r.Context().Done()
		close(canceled)
	}))
	t.Cleanup(server.Close)
	s, _, _ := configuredService(t, server.URL)
	if err := s.Send("Start a task"); err != nil {
		t.Fatal(err)
	}
	waitState(t, s, func(st State) bool { return countText(st.Messages, "Working") == 1 })
	s.Abort()
	waitState(t, s, func(st State) bool { return !st.Running })
	select {
	case <-canceled:
	case <-time.After(5 * time.Second):
		t.Fatal("abort did not cancel the live provider HTTP request")
	}
}

func TestCompactionUsesSavedCredential(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.Header.Get("Authorization") != "Bearer private-summary-key" {
			t.Error("compaction lost the session credential")
		}
		startSSE(w)
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": "The user requested a note."}}}})
		finishSSE(w, "stop")
	}))
	defer server.Close()
	model, err := resolveModel("deepseek-flash", server.URL+"/v1")
	if err != nil {
		t.Fatal(err)
	}
	policy := compactionPolicy(model, "private-summary-key")
	summary, err := policy.Summarize(context.Background(), []agenttypes.AgentMessage{
		agenttypes.NewAgentMessageFromMessage(aitypes.NewUserMessageVariant(aitypes.NewUserMessage("Create a note", 1))),
	})
	if err != nil || summary != "The user requested a note." || requests.Load() != 1 {
		t.Fatalf("credential-bound Pith compaction failed: %q, %v", summary, err)
	}
}

func TestCompactionPreservesVisibleActiveBranchAfterReopen(t *testing.T) {
	root := t.TempDir()
	folder, dataDir := filepath.Join(root, "workspace"), filepath.Join(root, "private")
	if err := os.Mkdir(folder, 0700); err != nil {
		t.Fatal(err)
	}
	s, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	workspace, err := s.AddWorkspace(folder)
	if err != nil {
		t.Fatal(err)
	}
	conversation, err := s.CreateConversation(workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	manager, err := codingagent.OpenSession(s.sessionFile(conversation.ID))
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	appendMessage := func(message aitypes.Message) codingagent.SessionEntry {
		raw, err := json.Marshal(agenttypes.NewAgentMessageFromMessage(message))
		if err != nil {
			t.Fatal(err)
		}
		entry, err := manager.AppendMessage(raw)
		if err != nil {
			t.Fatal(err)
		}
		return entry
	}
	assistant := func(text string) aitypes.Message {
		message := aitypes.NewAssistantMessage(aitypes.ApiOpenAICompletions, aitypes.ProviderDeepSeek, "deepseek-flash", 1)
		message.Content = []aitypes.ContentBlock{aitypes.TextBlock(text)}
		message.StopReason = aitypes.StopReasonStop
		return aitypes.NewAssistantMessageVariant(message)
	}
	appendMessage(aitypes.NewUserMessageVariant(aitypes.NewUserMessage("Original user request", 1)))
	appendMessage(assistant("Original assistant reply"))
	kept := appendMessage(aitypes.NewUserMessageVariant(aitypes.NewUserMessage("Recent user request", 2)))
	checkpoint, err := manager.AppendCompaction(codingagent.CompactionInput{
		Summary: "A summary of earlier messages", FirstKeptEntryID: kept.ID, TokensBefore: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	appendMessage(assistant("Discarded sibling reply"))
	if err := manager.Branch(checkpoint.ID); err != nil {
		t.Fatal(err)
	}
	appendMessage(assistant("Active branch reply"))
	// Prove this fixture really has distinct model and complete history views.
	for _, entry := range manager.BuildContextEntries() {
		if strings.Contains(string(entry.Payload), "Original user request") {
			t.Fatal("fixture did not compact the old request from model context")
		}
	}
	if err := manager.Close(); err != nil {
		t.Fatal(err)
	}
	if err := s.OpenConversation(conversation.ID); err != nil {
		t.Fatal(err)
	}
	assertHistory := func(state State) {
		t.Helper()
		for _, text := range []string{"Original user request", "Original assistant reply", "Recent user request", "Active branch reply"} {
			if countText(state.Messages, text) != 1 {
				t.Fatalf("visible history lost %q after compaction: %+v", text, state.Messages)
			}
		}
		if countText(state.Messages, "Discarded sibling reply") != 0 {
			t.Fatal("history included a sibling outside the active branch")
		}
	}
	assertHistory(s.Snapshot())
	s.Close()
	reopened, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reopened.Close)
	assertHistory(reopened.Snapshot())
}

func TestDataDirectoryLockRejectsSecondInstanceAndReleasesOnClose(t *testing.T) {
	dataDir := t.TempDir()
	first, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(first.Close)
	second, err := New(dataDir)
	if err == nil {
		second.Close()
		t.Fatal("two independent services could write the same application store")
	}
	if !strings.Contains(err.Error(), "already open") {
		t.Fatalf("wrong duplicate-instance error: %v", err)
	}
	first.Close()
	// The leftover lock file is expected and must not act as a stale PID lock.
	if _, err := os.Stat(filepath.Join(dataDir, ".desk.lock")); err != nil {
		t.Fatal(err)
	}
	reopened, err := New(dataDir)
	if err != nil {
		t.Fatalf("closing the first service did not release its OS lock: %v", err)
	}
	reopened.Close()
}

func TestDataDirectoryLockReleasedAfterProcessKill(t *testing.T) {
	dataDir := t.TempDir()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, executable, "-test.run=^TestDataDirectoryLockSubprocess$")
	command.Env = append(os.Environ(), "PITH_DESK_TEST_LOCK_DIR="+dataDir)
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = command.Process.Kill()
		_ = command.Wait()
	}()
	ready := make(chan string, 1)
	go func() {
		line, _ := bufio.NewReader(stdout).ReadString('\n')
		ready <- strings.TrimSpace(line)
	}()
	select {
	case message := <-ready:
		if message != "store locked" {
			t.Fatalf("lock subprocess did not start: %q", message)
		}
	case <-ctx.Done():
		t.Fatal("lock subprocess did not report startup")
	}
	if second, err := New(dataDir); err == nil {
		second.Close()
		t.Fatal("a second OS process could open the locked store")
	}
	if err := command.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = command.Wait()
	reopened, err := New(dataDir)
	if err != nil {
		t.Fatalf("process death left a stale application lock: %v", err)
	}
	reopened.Close()
}

func TestDataDirectoryLockSubprocess(t *testing.T) {
	dataDir := os.Getenv("PITH_DESK_TEST_LOCK_DIR")
	if dataDir == "" {
		return
	}
	service, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	// Deliberately do not Close: the parent kills this process to test OS cleanup.
	_ = service
	fmt.Fprintln(os.Stdout, "store locked")
	<-time.After(time.Hour)
}

func TestWorkspacePolicyRejectsEscapeAndSanitizesApprovedShell(t *testing.T) {
	root := t.TempDir()
	folder, dataDir := filepath.Join(root, "workspace"), filepath.Join(root, "private")
	if err := os.Mkdir(folder, 0700); err != nil {
		t.Fatal(err)
	}
	s, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	if _, err := s.AddWorkspace(root); err == nil {
		t.Fatal("a workspace containing private application data was accepted")
	}
	policy, err := newFilePolicy(folder, dataDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = policy.root.Close() })
	registry, err := s.buildTools(policy)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = registry.CloseTools() })
	secret := filepath.Join(root, "outside.txt")
	if err := os.WriteFile(secret, []byte("external-secret"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, filepath.Join(folder, "escape.txt")); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{secret, "../outside.txt", "escape.txt", dataDir} {
		args, _ := json.Marshal(map[string]any{"path": path})
		if _, err := registry.Execute(context.Background(), codingagent.ToolCall{ID: "escape", Name: "read_file", Arguments: args}); err == nil {
			t.Fatalf("read escaped the workspace: %s", path)
		}
	}
	for _, name := range []string{"read", "write", "edit", "bash", "grep", "find", "ls"} {
		if _, err := registry.ExecuteNested(context.Background(), codingagent.ToolCall{ID: "builtin", Name: name, Arguments: json.RawMessage(`{}`)}); err == nil {
			t.Fatalf("unguarded builtin %s was callable", name)
		}
	}
	grepResult, err := registry.Execute(context.Background(), codingagent.ToolCall{ID: "grep", Name: "grep_files", Arguments: json.RawMessage(`{"pattern":"external-secret"}`)})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(blockText(grepResult.Content), "external-secret") {
		t.Fatal("recursive search read the external symlink target")
	}
	t.Setenv("DEEPSEEK_API_KEY", "fixture-env-secret")
	t.Setenv("PORTSMITH_API_KEY", "fixture-env-secret")
	t.Setenv("DEMO_AUTH_TOKEN", "fixture-env-secret")
	result := make(chan codingagent.ToolResult, 1)
	runError := make(chan error, 1)
	go func() {
		out, err := registry.Execute(context.Background(), codingagent.ToolCall{ID: "shell", Name: "run_command",
			Arguments: json.RawMessage(`{"command":"printf '%s' \"${DEEPSEEK_API_KEY-unset}|${PORTSMITH_API_KEY-unset}|${DEMO_AUTH_TOKEN-unset}\""}`)})
		result <- out
		runError <- err
	}()
	state := waitState(t, s, func(st State) bool { return st.PendingApproval != nil })
	if !strings.Contains(state.PendingApproval.Warning, "no OS sandbox") {
		t.Fatal("shell approval hides its broader permissions")
	}
	if err := s.DecideApproval(state.PendingApproval.ID, true); err != nil {
		t.Fatal(err)
	}
	select {
	case out := <-result:
		if err := <-runError; err != nil {
			t.Fatal(err)
		}
		if text := blockText(out.Content); text != "unset|unset|unset" {
			t.Fatalf("ambient credentials reached the shell: %q", text)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("approved shell did not complete")
	}
}

func configuredService(t *testing.T, providerURL string) (*Service, string, string) {
	t.Helper()
	root := t.TempDir()
	folder, dataDir := filepath.Join(root, "workspace"), filepath.Join(root, "private")
	if err := os.Mkdir(folder, 0700); err != nil {
		t.Fatal(err)
	}
	s, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	if err := s.Configure(ConfigInput{BaseURL: providerURL + "/v1", Model: "deepseek-flash", APIKey: "fixture-private-key"}); err != nil {
		t.Fatal(err)
	}
	workspace, err := s.AddWorkspace(folder)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateConversation(workspace.ID); err != nil {
		t.Fatal(err)
	}
	return s, folder, dataDir
}

func waitState(t *testing.T, s *Service, predicate func(State) bool) State {
	t.Helper()
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	for {
		state := s.Snapshot()
		if predicate(state) {
			return state
		}
		select {
		case <-s.Changes():
		case <-deadline.C:
			t.Fatalf("expected state was not reached: %+v", state)
		}
	}
}

func countText(messages []Message, text string) int {
	count := 0
	for _, message := range messages {
		if message.Text == text {
			count++
		}
	}
	return count
}

func startSSE(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
}

func sse(w http.ResponseWriter, value any) {
	data, _ := json.Marshal(value)
	_, _ = fmt.Fprintf(w, "data: %s\n\n", data)
	w.(http.Flusher).Flush()
}

func finishSSE(w http.ResponseWriter, reason string) {
	sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{}, "finish_reason": reason}},
		"usage": map[string]any{"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}})
	_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	w.(http.Flusher).Flush()
}
