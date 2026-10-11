package desk

import (
	"context"
	"encoding/json"
	"errors"
	"image/color"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/minifish-org/pith-desk/internal/localstore"
	"github.com/minifish-org/pith-desk/internal/testsupport/filefault"
	"github.com/minifish-org/pith/packages/durable"
	"github.com/minifish-org/pith/packages/mcp"
)

// A live recovered task may be continued after its MCP config changes. Pending
// task input belongs to RunExecution; credentials belong to Connections, and
// the new execution must get the current login rather than the invalid backup.
func TestLiveTaskRecoveryAfterMCPAuthCleanupFailure(t *testing.T) {
	auth := make(chan string, 4)
	connector := newDeskMCPFixture(t, "", func(_ http.ResponseWriter, r *http.Request) bool {
		auth <- r.Header.Get("Authorization")
		return true
	})
	requests := make(chan map[string]any, 8)
	release := make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	var calls atomic.Int64
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		requests <- body
		n := calls.Add(1)
		if n == 2 {
			http.Error(w, `{"error":{"message":"end the uncertain turn"}}`, http.StatusBadRequest)
			return
		}
		startSSE(w)
		w.(http.Flusher).Flush()
		if n == 1 {
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
		}
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": "fixture reply"}}}})
		finishSSE(w, "stop")
	}))
	t.Cleanup(provider.Close)
	s, _, _ := configuredService(t, provider.URL)
	input := MCPInput{Name: "office", Type: "http", URL: connector.server.URL, OAuth: true, Enabled: true}
	if err := s.SaveMCP(input); err != nil {
		t.Fatal(err)
	}
	config := s.connections.mcpConfigs[0]
	expiry := time.Now().Add(time.Hour).UnixMilli()
	if err := s.mcpOAuthStore(config).Save(mcp.McpOAuthState{ServerURL: config.URL, Tokens: &mcp.OAuthTokens{AccessToken: "old-login"}, TokensExpireAt: &expiry}); err != nil {
		t.Fatal(err)
	}
	var reject atomic.Bool
	reject.Store(true)
	installJournalWindow(s, func(_ context.Context, writes []durable.StorageWrite) error {
		if reject.Load() && journalHasKind(writes, "desk.delivered") {
			return filefault.ErrInjected
		}
		return nil
	}, nil)
	id := s.Snapshot().ActiveID
	if err := s.Send("start with old login"); err != nil {
		t.Fatal(err)
	}
	receiveProviderRequest(t, requests)
	select {
	case header := <-auth:
		if header != "Bearer old-login" {
			t.Fatal("original task did not use the original login")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("original MCP runtime was not initialized")
	}
	for _, text := range []string{"pending first", "pending second"} {
		if err := s.QueueMessage(id, text, QueueFollowUp, imageFixture(t, color.White)); err != nil {
			t.Fatal(err)
		}
	}
	queued := s.Snapshot().QueuedMessages
	releaseOnce.Do(func() { close(release) })
	receiveProviderRequest(t, requests)
	failed := waitState(t, s, func(st State) bool { return !st.Running })
	if !reflect.DeepEqual(failed.QueuedMessages, queued) || failed.Failure == nil || !failed.Failure.CanContinue {
		t.Fatal("live task input was not recovered before reconfiguration")
	}
	blocker := &mcpCleanupBlocker{authDir: filepath.Dir(s.mcpOAuthStore(config).path), armed: true}
	s.files = localstore.Store{FS: blocker}
	changed := input
	changed.OAuthScope = "changed-scope"
	if err := s.SaveMCP(changed); err == nil || !strings.Contains(err.Error(), "old OAuth cleanup failed") {
		t.Fatal(err)
	}
	blocker.repair(t)
	s.files = localstore.Store{}
	if err := s.SaveMCP(input); err != nil {
		t.Fatal(err)
	}
	assertMCPHasNoLogin(t, s, config)
	if _, err := os.Stat(blocker.backup); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("configuration reuse left obsolete credentials for a later restart")
	}
	if !reflect.DeepEqual(s.Snapshot().QueuedMessages, queued) || calls.Load() != 2 {
		t.Fatal("MCP recovery changed task input or started a task")
	}
	if err := s.mcpOAuthStore(config).Save(mcp.McpOAuthState{ServerURL: config.URL, Tokens: &mcp.OAuthTokens{AccessToken: "fresh-login"}, TokensExpireAt: &expiry}); err != nil {
		t.Fatal(err)
	}
	reject.Store(false)
	if err := s.ContinueTask(id); err != nil {
		t.Fatal(err)
	}
	receiveProviderRequest(t, requests)
	for _, message := range queued {
		body := receiveProviderRequest(t, requests)
		items := body["messages"].([]any)
		last := map[string]any{"messages": []any{items[len(items)-1]}}
		if countProviderUser(last, message.Text) != 1 || !reflect.DeepEqual(providerImageURLs(last), []string{"data:image/png;base64," + message.Images[0].Data}) {
			t.Fatal("reconfigured Continue lost pending text, attachment or order")
		}
	}
	state := waitState(t, s, func(st State) bool { return !st.Running })
	if state.Error != "" || state.Runtime.Phase != "complete" || state.Runtime.RunID == failed.Runtime.RunID {
		t.Fatalf("reconfigured continuation failed: %+v", state)
	}
	select {
	case header := <-auth:
		if header != "Bearer fresh-login" {
			t.Fatalf("new execution reused invalid credentials: %q", header)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("continued MCP runtime was not initialized")
	}
}
