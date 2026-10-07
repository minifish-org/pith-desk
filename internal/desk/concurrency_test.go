package desk

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestWorkspaceMCPAbortLeavesOtherTransportAlive(t *testing.T) {
	entered := make(chan int32, 2)
	canceledA, canceledB := make(chan struct{}), make(chan struct{})
	finishB := make(chan struct{})
	connector := newDeskMCPFixture(t, "", nil)
	connector.call = func(req *http.Request) bool {
		n := connector.calls.Load()
		entered <- n
		if n == 1 {
			<-req.Context().Done()
			close(canceledA)
			return false
		}
		select {
		case <-finishB:
			return true
		case <-req.Context().Done():
			close(canceledB)
			return false
		}
	}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var body struct {
			Messages []struct {
				Role string `json:"role"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		startSSE(w)
		for _, message := range body.Messages {
			if message.Role == "tool" {
				sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": "MCP done"}}}})
				finishSSE(w, "stop")
				return
			}
		}
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"index": 0, "id": "slow", "type": "function", "function": map[string]any{"name": "codemode", "arguments": `{"code":"return await tools.mcp__slow__echo({});"}`}}}}}}})
		finishSSE(w, "tool_calls")
	}))
	defer provider.Close()
	s, _, _ := configuredService(t, provider.URL)
	defer s.Close()
	if err := s.SaveMCP(MCPInput{Name: "slow", Type: "http", URL: connector.server.URL, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	idA := s.Snapshot().ActiveID
	for i := 0; i < 2; i++ {
		if i == 1 {
			addTestConversation(t, s, t.TempDir())
		}
		if err := s.SetPermissionMode(s.Snapshot().ActiveID, PermissionFullAccess); err != nil {
			t.Fatal(err)
		}
		if err := s.Send("Run MCP"); err != nil {
			t.Fatal(err)
		}
		select {
		case <-entered:
		case <-time.After(30 * time.Second):
			t.Fatal("MCP did not start independently")
		}
	}
	if err := s.AbortConversation(idA); err != nil {
		t.Fatal(err)
	}
	waitState(t, s, func(st State) bool { return len(st.Runs) == 1 })
	select {
	case <-canceledA:
	case <-time.After(30 * time.Second):
		t.Fatal("A's MCP request survived abort")
	}
	select {
	case <-canceledB:
		t.Fatal("A's abort closed B's transport")
	default:
	}
	close(finishB)
	st := waitState(t, s, func(st State) bool { return !st.Running })
	if st.Error != "" || st.Runtime.Phase != "complete" || countText(st.Messages, "MCP done") != 1 {
		t.Fatalf("B failed after A stopped: %+v", st)
	}
}

func addTestConversation(t *testing.T, s *Service, path string) (Workspace, Conversation) {
	t.Helper()
	w, err := s.AddWorkspace(path)
	if err != nil {
		t.Fatal(err)
	}
	c, err := s.CreateConversation(w.ID)
	if err != nil {
		t.Fatal(err)
	}
	return w, c
}

func TestConversationSwitchRollbackPreservesRunAdmissionAndAbort(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		startSSE(w)
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": "Waiting"}}}})
		<-req.Context().Done()
	}))
	defer provider.Close()
	s, _, dataDir := configuredService(t, provider.URL)
	defer s.Close()
	initial := s.Snapshot()
	other, err := s.CreateConversation(initial.Workspaces[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	// Force catalog persistence to fail after selecting the requested view.
	catalogPath := filepath.Join(dataDir, "catalog.json")
	catalog, err := os.ReadFile(catalogPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(catalogPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(catalogPath, 0700); err != nil {
		t.Fatal(err)
	}
	if err := s.OpenConversation(initial.ActiveID); err == nil {
		t.Fatal("catalog failure was hidden")
	}
	if s.Snapshot().ActiveID != other.ID {
		t.Fatal("failed switch changed the selected conversation")
	}
	if err := os.Remove(catalogPath); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(catalogPath, catalog, 0600); err != nil {
		t.Fatal(err)
	}
	if err := s.Send("Start after failed switch"); err != nil {
		t.Fatal(err)
	}
	waitState(t, s, func(st State) bool { return countText(st.Messages, "Waiting") == 1 })
	if err := s.OpenConversation(initial.ActiveID); err != nil {
		t.Fatal(err)
	}
	if err := s.Send("Must not overlap"); err == nil {
		t.Fatal("failed switch lost the workspace reservation")
	}
	if err := s.AbortConversation(other.ID); err != nil {
		t.Fatalf("failed switch lost targeted cancellation: %v", err)
	}
	waitState(t, s, func(st State) bool { return len(st.Runs) == 0 })
}

func TestWorkspaceConcurrencyIsolatesStreamsApprovalQueuesAbortAndCosts(t *testing.T) {
	finishB := make(chan struct{})
	var requestsA, requestsB atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		body, _ := io.ReadAll(req.Body)
		label, count := "A", &requestsA
		if strings.Contains(string(body), "Task B") {
			label, count = "B", &requestsB
		}
		other := "A"
		if label == "A" {
			other = "B"
		}
		if strings.Contains(string(body), "Task "+other) || strings.Contains(string(body), "queued "+other) {
			t.Errorf("%s received another conversation's input", label)
		}
		startSSE(w)
		switch count.Add(1) {
		case 1:
			args, _ := json.Marshal(map[string]string{"path": "note.txt", "content": label})
			sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"index": 0, "id": "write-" + label, "type": "function", "function": map[string]any{"name": "write_file", "arguments": string(args)}}}}}}})
			finishSSE(w, "tool_calls")
		case 2:
			sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": label + " streaming"}}}})
			if label == "A" {
				<-req.Context().Done()
				return
			}
			select {
			case <-finishB:
				finishSSE(w, "stop")
			case <-req.Context().Done():
			}
		default:
			sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": label + " queued answer"}}}})
			finishSSE(w, "stop")
		}
	}))
	defer provider.Close()
	s, folderA, _ := configuredService(t, provider.URL)
	defer s.Close()
	idA := s.Snapshot().ActiveID
	if err := s.Send("Task A"); err != nil {
		t.Fatal(err)
	}
	stateA := waitState(t, s, func(st State) bool { return st.PendingApproval != nil })
	approvalA := stateA.PendingApproval.ID
	folderB := t.TempDir()
	_, convB := addTestConversation(t, s, folderB)
	if err := s.Send("Task B"); err != nil {
		t.Fatal(err)
	}
	stateB := waitState(t, s, func(st State) bool { return st.PendingApproval != nil && len(st.Runs) == 2 })
	if stateB.PendingApproval.ID == stateA.PendingApproval.ID {
		t.Fatal("approval identity was shared")
	}
	// A stale send is rejected instead of being redirected to the current UI.
	if err := s.SendConversation(idA, "misdirected"); err == nil {
		t.Fatal("stale send accepted")
	}
	// An approval submitted before switching still belongs to its original task.
	if err := s.DecideApprovalWithScope(stateA.PendingApproval.ID, true, true); err != nil {
		t.Fatal(err)
	}
	for _, c := range s.Snapshot().Conversations {
		if c.ID == convB.ID && c.PermissionMode != PermissionAsk {
			t.Fatal("A's lasting permission leaked into B")
		}
	}
	if _, err := os.Stat(filepath.Join(folderB, "note.txt")); !os.IsNotExist(err) {
		t.Fatal("B wrote without approval")
	}
	if err := s.DecideApproval(stateB.PendingApproval.ID, true); err != nil {
		t.Fatal(err)
	}
	waitState(t, s, func(st State) bool { return countText(st.Messages, "B streaming") == 1 })
	if err := s.OpenConversation(idA); err != nil {
		t.Fatal(err)
	}
	stateA = waitState(t, s, func(st State) bool { return countText(st.Messages, "A streaming") == 1 })
	if countText(stateA.Messages, "B streaming") != 0 {
		t.Fatal("B stream leaked into A")
	}
	if err := s.QueueMessage(idA, "queued A", ""); err != nil {
		t.Fatal(err)
	}
	queueA := s.Snapshot().QueuedMessages[0].ID
	if err := s.OpenConversation(convB.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.QueueMessage(convB.ID, "queued B", ""); err != nil {
		t.Fatal(err)
	}
	if err := s.MutateQueuedMessage(idA, queueA, "edit", "queued A edited"); err != nil {
		t.Fatal(err)
	}
	if st := s.Snapshot(); len(st.QueuedMessages) != 1 || st.QueuedMessages[0].Text != "queued B" {
		t.Fatal("queue mutation changed B")
	}
	if err := s.AbortConversation(idA); err != nil {
		t.Fatal(err)
	}
	stateB = waitState(t, s, func(st State) bool { return len(st.Runs) == 1 })
	if !stateB.Running || stateB.ActiveID != convB.ID {
		t.Fatal("stopping A stopped or switched B")
	}
	if err := s.DecideApproval(approvalA, true); err == nil {
		t.Fatal("stale approval accepted")
	}
	close(finishB)
	stateB = waitState(t, s, func(st State) bool { return !st.Running })
	if stateB.Runtime.Phase != "complete" || stateB.Error != "" || countText(stateB.Messages, "B queued answer") != 1 {
		t.Fatalf("B failed: %+v", stateB)
	}
	if stateB.Runtime.Timing.OutputTokens != 15 {
		t.Fatalf("B's output included another run: %+v", stateB.Runtime)
	}
	if err := s.OpenConversation(idA); err != nil {
		t.Fatal(err)
	}
	stateA = s.Snapshot()
	if stateA.Runtime.Phase != "stopped" || len(stateA.QueuedMessages) != 0 || countText(stateA.Messages, "B queued answer") != 0 {
		t.Fatalf("A isolation failed: %+v", stateA)
	}
	if stateA.Runtime.Timing.OutputTokens != 5 {
		t.Fatalf("A's output included B: %+v", stateA.Runtime)
	}
	for id, expected := range map[string]int{idA: 1, convB.ID: 3} {
		costs, err := s.Costs(id)
		if err != nil || costs.RunRequests != expected {
			t.Fatalf("isolated ledger %s: %+v %v", id, costs, err)
		}
	}
	for folder, content := range map[string]string{folderA: "A", folderB: "B"} {
		data, err := os.ReadFile(filepath.Join(folder, "note.txt"))
		if err != nil || string(data) != content {
			t.Fatalf("wrong workspace write: %q %v", data, err)
		}
	}
	// Snapshots remain detached even when the viewed runtime is live.
	stateA.Messages[0].Text = "tampered"
	stateA.Runtime.Phase = "tampered"
	if st := s.Snapshot(); st.Messages[0].Text == "tampered" || st.Runtime.Phase == "tampered" {
		t.Fatal("snapshot aliases runtime")
	}
}

func TestWorkspaceConcurrencyRejectsOverlappingFoldersAndProtectsLiveData(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		startSSE(w)
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": "Waiting"}}}})
		<-req.Context().Done()
	}))
	defer provider.Close()
	s, folder, _ := configuredService(t, provider.URL)
	defer s.Close()
	id := s.Snapshot().ActiveID
	workspace := s.Snapshot().Workspaces[0]
	if err := s.Send("Hold"); err != nil {
		t.Fatal(err)
	}
	waitState(t, s, func(st State) bool { return countText(st.Messages, "Waiting") == 1 })
	if _, err := s.CreateConversation(workspace.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.Send("second in same workspace"); err == nil {
		t.Fatal("same workspace ran concurrently")
	}
	child := filepath.Join(folder, "nested")
	if err := os.Mkdir(child, 0700); err != nil {
		t.Fatal(err)
	}
	addTestConversation(t, s, child)
	if err := s.Send("overlapping child"); err == nil {
		t.Fatal("nested workspace ran concurrently")
	}
	if err := s.RemoveWorkspace(workspace.ID, 2); err == nil {
		t.Fatal("running workspace removed")
	}
	if err := s.DeleteConversation(id); err == nil {
		t.Fatal("running conversation deleted")
	}
	if err := s.RenameConversation(id, "unsafe"); err == nil {
		t.Fatal("running transcript changed")
	}
	if _, err := s.CreateInstructions(workspace.ID); err == nil {
		t.Fatal("running workspace instructions changed")
	}
	if err := s.Configure(ConfigInput{BaseURL: provider.URL + "/v1", Model: "deepseek-flash"}); err == nil {
		t.Fatal("global config changed from an idle view")
	}
	_, idle := addTestConversation(t, s, t.TempDir())
	if err := s.RenameConversation(idle.ID, "safe unrelated edit"); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteConversation(idle.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.OpenConversation(id); err != nil {
		t.Fatal(err)
	}
	if err := s.AbortConversation(id); err != nil {
		t.Fatal(err)
	}
	waitState(t, s, func(st State) bool { return !st.Running })
	if err := s.Send("workspace slot released"); err != nil {
		t.Fatal(err)
	}
}

func TestCloseCancelsAllWorkspacesAndRecoversTheirQueuesIndependently(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		startSSE(w)
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": "Waiting"}}}})
		<-req.Context().Done()
	}))
	defer provider.Close()
	s, _, dataDir := configuredService(t, provider.URL)
	defer s.Close()
	idA := s.Snapshot().ActiveID
	if err := s.Send("Task A"); err != nil {
		t.Fatal(err)
	}
	waitState(t, s, func(st State) bool { return countText(st.Messages, "Waiting") == 1 })
	if err := s.QueueMessage(idA, "pending A", ""); err != nil {
		t.Fatal(err)
	}
	_, b := addTestConversation(t, s, t.TempDir())
	if err := s.Send("Task B"); err != nil {
		t.Fatal(err)
	}
	waitState(t, s, func(st State) bool { return countText(st.Messages, "Waiting") == 1 && len(st.Runs) == 2 })
	if err := s.QueueMessage(b.ID, "pending B", ""); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { s.Close(); close(done) }()
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("closing multiple runs deadlocked")
	}
	reopened, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	for id, pending := range map[string]string{idA: "pending A", b.ID: "pending B"} {
		if err := reopened.OpenConversation(id); err != nil {
			t.Fatal(err)
		}
		st := reopened.Snapshot()
		if st.Running || len(st.Runs) != 0 || st.Failure == nil || st.Failure.Kind != "interrupted" || len(st.QueuedMessages) != 1 || st.QueuedMessages[0].Text != pending {
			t.Fatalf("unsafe or mixed recovery: %+v", st)
		}
	}
}
