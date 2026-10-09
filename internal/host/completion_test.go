package host

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/minifish-org/pith-desk/internal/desk"
)

func TestCompletionNotificationsDeduplicateAndIgnoreOldResults(t *testing.T) {
	state := desk.State{Conversations: []desk.Conversation{{ID: "a", CompletedRunID: "old", Unread: true}}}
	s := &Server{completedRuns: completionBaseline(state)}
	if len(s.newCompletionsLocked(state)) != 0 {
		t.Fatal("startup replayed an old notification")
	}
	state.Conversations = []desk.Conversation{
		{ID: "a", CompletedRunID: "new-a", Unread: true},
		{ID: "b", CompletedRunID: "new-b", Unread: true},
	}
	if len(s.newCompletionsLocked(state)) != 2 {
		t.Fatal("coalesced completions lost a workspace")
	}
	if len(s.newCompletionsLocked(state)) != 0 {
		t.Fatal("duplicate snapshot repeated a notification")
	}
	state.Conversations = []desk.Conversation{{ID: "a", CompletedRunID: "viewed", Unread: false}}
	if len(s.newCompletionsLocked(state)) != 0 || len(s.completedRuns) != 1 {
		t.Fatal("viewed result notified or deleted conversation remained retained")
	}
}

func TestCompletionReadRouteRequiresKnownConversationAndAuthorization(t *testing.T) {
	s := testServer(t)
	w, err := s.service.AddWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	c, err := s.service.CreateConversation(w.ID)
	if err != nil {
		t.Fatal(err)
	}
	status, _, _ := featureRequest(t, s, "POST", "/api/read", map[string]string{"id": c.ID, "runId": "stale"}, true)
	if status != 200 {
		t.Fatalf("stale acknowledgement rejected: %d", status)
	}
	status, _, _ = featureRequest(t, s, "POST", "/api/read", map[string]string{"id": "missing", "runId": "stale"}, true)
	if status != 400 {
		t.Fatalf("unknown conversation accepted: %d", status)
	}
	status, _, _ = featureRequest(t, s, "POST", "/api/read", map[string]string{"id": c.ID}, false)
	if status != 401 {
		t.Fatalf("read acknowledgement bypassed authentication: %d", status)
	}
}

func TestCompletionCallbackRunsOnceWithoutBlockingStateBroadcasts(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Done\"}}]}\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
		w.(http.Flusher).Flush()
	}))
	defer provider.Close()
	s := testServer(t)
	w, err := s.service.AddWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	c, err := s.service.CreateConversation(w.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.service.Configure(desk.ConfigInput{BaseURL: provider.URL + "/v1", Model: "deepseek-flash", APIKey: "fixture-key"}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, strings.Replace(s.URL, "http://", "ws://", 1)+"/api/socket", &websocket.DialOptions{Subprotocols: []string{"pith-desk", "bearer." + s.token}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if _, _, err = conn.Read(ctx); err != nil {
		t.Fatal(err)
	}
	called := make(chan desk.Conversation, 2)
	release := make(chan struct{})
	defer close(release)
	s.SetCompletionAction(func(entry desk.Conversation, workspace desk.Workspace) {
		// Native callbacks must run outside the host/service locks.
		if workspace.ID != w.ID || s.service.Snapshot().Running {
			t.Error("notification fired before its task settled or for the wrong workspace")
		}
		called <- entry
		// MyGo waits here while macOS asks for notification permission.
		<-release
	})
	if err := s.service.Send("Finish"); err != nil {
		t.Fatal(err)
	}
	var completed desk.Conversation
	select {
	case completed = <-called:
	case <-time.After(10 * time.Second):
		t.Fatal("successful task did not notify")
	}
	if completed.ID != c.ID || completed.CompletedRunID == "" || !completed.Unread {
		t.Fatalf("wrong completion: %+v", completed)
	}
	if err := s.service.SetAppearance(desk.AppearanceLight); err != nil {
		t.Fatal(err)
	}
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("blocked completion callback stopped frontend snapshots: %v", err)
		}
		var state desk.State
		if err := json.Unmarshal(data, &state); err != nil {
			t.Fatal(err)
		}
		if state.Settings.Appearance == desk.AppearanceLight {
			break
		}
	}
	if err := s.service.MarkConversationRead(c.ID, completed.CompletedRunID); err != nil {
		t.Fatal(err)
	}
	if err := s.service.OpenConversation(c.ID); err != nil {
		t.Fatal(err)
	}
	select {
	case <-called:
		t.Fatal("acknowledging/viewing repeated the completion notification")
	case <-time.After(50 * time.Millisecond):
	}
}
