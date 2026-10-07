package desk

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	authtypes "github.com/minifish-org/pith/packages/ai/auth/types"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
	"github.com/minifish-org/pith/packages/durable"
	"github.com/minifish-org/pith/packages/mcp"
)

func customFixture(id, url, key string) CustomConnectionInput {
	contextWindow, maxTokens := float64(128000), float64(8192)
	return CustomConnectionInput{ID: id, Name: id, BaseURL: url + "/v1", API: aitypes.ApiOpenAICompletions, APIKey: key,
		Models: []codingagent.ModelsJsonModel{{ID: "fixture", ContextWindow: &contextWindow, MaxTokens: &maxTokens,
			Cost: &aitypes.ModelCost{ModelCostRates: aitypes.ModelCostRates{Input: 2, Output: 4}}}}}
}

func TestIndependentCompatibleConnectionsAndImmutableCosts(t *testing.T) {
	calls := map[string]int{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := r.Header.Get("Authorization")
		calls[key]++
		startSSE(w)
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": "done"}}}})
		finishSSE(w, "stop")
	}))
	defer server.Close()
	s, _, conversation, dir := productFeatureService(t)
	for _, id := range []string{"custom-one", "custom-two"} {
		if err := s.SaveCustomConnection(customFixture(id, server.URL, id+"-secret")); err != nil {
			t.Fatal(err)
		}
	}
	for _, id := range []string{"custom-one", "custom-two"} {
		if err := s.SelectModel(id, "fixture", "off"); err != nil {
			t.Fatal(err)
		}
		if err := s.Send("hello"); err != nil {
			t.Fatal(err)
		}
		state := waitState(t, s, func(st State) bool { return !st.Running })
		if state.Failure != nil {
			t.Fatalf("custom adapter failed: %+v", state.Failure)
		}
	}
	if calls["Bearer custom-one-secret"] != 1 || calls["Bearer custom-two-secret"] != 1 {
		t.Fatalf("credentials crossed: %v", calls)
	}
	metadata, _ := s.CustomConnection("custom-one")
	encoded, _ := json.Marshal(metadata)
	if strings.Contains(string(encoded), "secret") {
		t.Fatal("saved credential returned to UI")
	}
	prices, err := s.Costs(conversation.ID)
	if err != nil || len(prices.Requests) != 2 || math.Abs(prices.Total-0.00008) > 1e-10 {
		t.Fatalf("ledger: %+v %v", prices, err)
	}
	if summary := s.Snapshot().Runtime.Cost; summary != prices.CostSummary || summary.RequestCount != 2 || summary.RunRequests != 1 || math.Abs(summary.RunTotal-0.00004) > 1e-10 {
		t.Fatalf("snapshot totals differ from the ledger: %+v", summary)
	}
	changed := customFixture("custom-one", server.URL, "")
	changed.Models[0].Cost.Input = 900
	if err := s.SaveCustomConnection(changed); err != nil {
		t.Fatal(err)
	}
	unchanged, _ := s.Costs(conversation.ID)
	if unchanged.Total != prices.Total || unchanged.Requests[0].Price.Input != 2 {
		t.Fatal("old costs recalculated with new prices")
	}
	if err := s.RemoveModelConnection("custom-two"); err == nil {
		t.Fatal("active connection removed")
	}
	s.Close()
	reopened, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if summary := reopened.Snapshot().Runtime.Cost; summary != prices.CostSummary {
		t.Fatalf("cost summary lost on restart: %+v", summary)
	}
	if err := reopened.SelectModel("custom-one", "fixture", "off"); err != nil {
		t.Fatal(err)
	}
	if err := reopened.Send("after restart"); err != nil {
		t.Fatal(err)
	}
	waitState(t, reopened, func(st State) bool { return !st.Running })
	if calls["Bearer custom-one-secret"] != 2 {
		t.Fatal("custom registration or credential lost on restart")
	}
	report, err := reopened.Costs(conversation.ID)
	if err != nil || reopened.Snapshot().Runtime.Cost != report.CostSummary || report.RequestCount != 3 || report.RunRequests != 1 {
		t.Fatalf("new task did not reset latest-task totals: %+v %v", report, err)
	}
}

func TestCompatibleLocalEndpointAcceptsAnEmptyKey(t *testing.T) {
	var authorization string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorization = r.Header.Get("Authorization")
		startSSE(w)
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": "local reply"}}}})
		finishSSE(w, "stop")
	}))
	defer server.Close()
	s, _, _, _ := productFeatureService(t)
	if err := s.SaveCustomConnection(customFixture("custom-local", server.URL, "")); err != nil {
		t.Fatal(err)
	}
	if err := s.SelectModel("custom-local", "fixture", "off"); err != nil {
		t.Fatal(err)
	}
	catalog, err := s.Models("custom-local")
	if err != nil {
		t.Fatal(err)
	}
	for _, provider := range catalog.Providers {
		if provider.ID == "custom-local" && (!provider.HasAPIKey || provider.HasSavedKey) {
			t.Fatal("Keyless connection readiness was confused with saved credentials")
		}
	}
	if err := s.Send("Local request"); err != nil {
		t.Fatal(err)
	}
	state := waitState(t, s, func(st State) bool { return !st.Running })
	if state.Failure != nil || authorization != "Bearer unused" {
		t.Fatalf("Local endpoint: %+v, header %q", state.Failure, authorization)
	}
}

func TestUnknownPricesAreNotFreeAndOfficialEndpointIsKnown(t *testing.T) {
	s, _, c, _ := productFeatureService(t)
	config := normalizedConfig(s.config)
	model, err := resolveConfiguredModel(config)
	if err != nil {
		t.Fatal(err)
	}
	response := aitypes.NewAssistantMessage(model.Api, model.Provider, model.Id, 1)
	response.Usage = aitypes.Usage{Input: 100, Output: 10, TotalTokens: 110}
	s.recordCost(c.ID, "one", "agent", model, config, response)
	config.BaseURL = "https://different-endpoint.example/v1"
	s.recordCost(c.ID, "two", "compaction", model, config, response)
	report, err := s.Costs(c.ID)
	if err != nil || !report.Requests[0].Known || report.Requests[1].Known || report.UnknownRequests != 1 {
		t.Fatalf("price provenance: %+v %v", report, err)
	}
	if !strings.Contains(report.Requests[0].Source, "2026-") {
		t.Fatal("catalog version missing")
	}
}

func TestInlineCostsRestoreFromLedgerWhenSwitchingConversations(t *testing.T) {
	s, workspace, original, _ := productFeatureService(t)
	config := normalizedConfig(s.config)
	model, err := resolveConfiguredModel(config)
	if err != nil {
		t.Fatal(err)
	}
	response := aitypes.NewAssistantMessage(model.Api, model.Provider, model.Id, 1)
	response.Usage = aitypes.Usage{Input: 100, Output: 10, TotalTokens: 110}
	s.recordCost(original.ID, "earlier", "agent", model, config, response)
	s.recordCost(original.ID, "latest", "compaction", model, config, response)
	config.BaseURL = "https://unknown-prices.example/v1"
	s.recordCost(original.ID, "latest", "agent", model, config, response)
	// A stale receipt must not override durable cost records.
	if err := writeJSON(s.receiptFile(original.ID), runReceipt{Runtime: RuntimeStatus{RunID: "latest", Phase: "complete", Model: model.Id}}); err != nil {
		t.Fatal(err)
	}
	other, err := s.CreateConversation(workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	if s.Snapshot().Runtime.Cost.RequestCount != 0 {
		t.Fatal("new conversation inherited cost totals")
	}
	if err := s.OpenConversation(original.ID); err != nil {
		t.Fatal(err)
	}
	report, err := s.Costs(original.ID)
	if err != nil || s.Snapshot().Runtime.Cost != report.CostSummary || report.RequestCount != 3 || report.RunRequests != 2 || report.UnknownRequests != 1 || report.RunUnknownRequests != 1 || math.Abs(report.Total-2*report.RunTotal) > 1e-10 {
		t.Fatalf("switching lost latest-task or partial totals: %+v %v", report, err)
	}
	if err := os.WriteFile(s.costFile(original.ID), []byte("invalid ledger"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := s.OpenConversation(other.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.OpenConversation(original.ID); err != nil {
		t.Fatal("cost ledger corruption prevented conversation access:", err)
	}
	if !s.Snapshot().Runtime.Cost.Unavailable {
		t.Fatal("unreadable ledger presented as a zero estimate")
	}
}

func TestManualCompactionKeepsHistoryAndMetersSummary(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		startSSE(w)
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": "A useful summary or reply."}}}})
		finishSSE(w, "stop")
	}))
	defer server.Close()
	s, _, c, _ := productFeatureService(t)
	if err := s.SaveCustomConnection(customFixture("custom-summary", server.URL, "fixture")); err != nil {
		t.Fatal(err)
	}
	if err := s.SelectModel("custom-summary", "fixture", "off"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 9; i++ {
		if err := s.Send("Keep this history visible."); err != nil {
			t.Fatal(err)
		}
		waitState(t, s, func(st State) bool { return !st.Running })
	}
	if err := s.CompactConversation(c.ID); err != nil {
		t.Fatal(err)
	}
	state := waitState(t, s, func(st State) bool { return !st.Running })
	if state.Failure != nil || state.Runtime.Compactions != 1 || countText(state.Messages, "Keep this history visible.") != 9 {
		t.Fatalf("manual compaction: %+v", state)
	}
	costs, err := s.Costs(c.ID)
	if err != nil || len(costs.Requests) != 10 || costs.Requests[9].Purpose != "compaction" || costs.RunTotal <= 0 {
		t.Fatalf("summary ledger: %+v %v", costs, err)
	}
}

func TestCodemodeNestedCallsKeepPermissionsAndFileBoundary(t *testing.T) {
	s, registry, folder, private := permissionService(t)
	script, _ := json.Marshal(map[string]string{"code": `await tools.write_file({path:"note.txt",content:"nested"}); return await tools.read_file({path:"note.txt"});`})
	result, _ := startTool(t, registry, "codemode", string(script))
	state := waitState(t, s, func(st State) bool { return st.PendingApproval != nil })
	if state.PendingApproval.ToolName != "write_file" {
		t.Fatal("nested approval bypassed")
	}
	if _, err := os.Stat(filepath.Join(folder, "note.txt")); !os.IsNotExist(err) {
		t.Fatal("write before approval")
	}
	if err := s.DecideApproval(state.PendingApproval.ID, true); err != nil {
		t.Fatal(err)
	}
	outcome := waitTool(t, result)
	if outcome.err != nil || outcome.result.IsError || !strings.Contains(blockText(outcome.result.Content), "nested") {
		t.Fatalf("codemode: %+v", outcome)
	}
	if err := os.WriteFile(filepath.Join(private, "secret"), []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	script, _ = json.Marshal(map[string]string{"code": `return await tools.read_file({path:` + string(mustJSON(t, filepath.Join(private, "secret"))) + `});`})
	result, _ = startTool(t, registry, "codemode", string(script))
	outcome = waitTool(t, result)
	if !outcome.result.IsError || strings.Contains(blockText(outcome.result.Content), `"private"`) {
		t.Fatal("codemode escaped file boundary")
	}
}

func TestDeferredMCPDiscoveryAndCodemodeShareExternalApproval(t *testing.T) {
	s, _, _, _ := productFeatureService(t)
	connector := newDeskMCPFixture(t, "", nil)
	if err := s.SaveMCP(MCPInput{Name: "fixture", Type: "http", URL: connector.server.URL, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if err := s.ConnectMCP(context.Background()); err != nil {
		t.Fatal(err)
	}
	policy, err := newFilePolicy(s.state.Workspaces[0].Path, s.dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer policy.root.Close()
	registry, err := s.buildTools(policy)
	if err != nil {
		t.Fatal(err)
	}
	defer registry.CloseTools()
	for _, tool := range registry.AgentTools() {
		if strings.HasPrefix(tool.Name, "mcp__") {
			t.Fatal("deferred MCP schema exposed eagerly")
		}
	}
	result, err := registry.Execute(context.Background(), codingagent.ToolCall{Name: "tool_search", Arguments: json.RawMessage(`{"query":"echo"}`)})
	if err != nil || !strings.Contains(blockText(result.Content), "echo") {
		t.Fatalf("search: %+v %v", result, err)
	}
	output, _ := startTool(t, registry, "codemode", `{"code":"return await tools.mcp__fixture__echo({message:'hi'});"}`)
	state := waitState(t, s, func(st State) bool { return st.PendingApproval != nil })
	if connector.calls.Load() != 0 {
		t.Fatal("MCP executed before approval")
	}
	if err := s.DecideApproval(state.PendingApproval.ID, true); err != nil {
		t.Fatal(err)
	}
	if outcome := waitTool(t, output); outcome.err != nil || outcome.result.IsError {
		t.Fatalf("nested MCP: %+v", outcome)
	}
}

func TestResourceEditingUsesSDKDiscoveryAndRestrictsInheritedInstructions(t *testing.T) {
	s, w, _, _ := productFeatureService(t)
	for _, in := range []ResourceInput{{WorkspaceID: w.ID, Kind: "instructions", Content: "Workspace instructions"}, {WorkspaceID: w.ID, Kind: "skill", Name: "writer", Content: "---\nname: writer\ndescription: Write notes\n---\nSkill instructions"}, {WorkspaceID: w.ID, Kind: "template", Name: "brief", Content: "---\ndescription: Write a brief\n---\nPlease summarize $@."}} {
		if err := s.SaveResource(in); err != nil {
			t.Fatal(err)
		}
	}
	inventory, err := s.Resources(w.ID)
	if err != nil || len(inventory.Skills) != 1 || len(inventory.Templates) != 1 {
		t.Fatalf("resource inventory: %+v %v", inventory, err)
	}
	body, err := s.ResourceContent(w.ID, inventory.Skills[0].Path)
	if err != nil || !strings.Contains(body["content"], "Skill instructions") {
		t.Fatal("editor could not read discovered skill")
	}
	template := inventory.Templates[0].Path
	if err := s.SaveResource(ResourceInput{WorkspaceID: w.ID, Path: template, Content: "Updated $@"}); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveResource(ResourceInput{WorkspaceID: w.ID, Path: template, Remove: true}); err != nil {
		t.Fatal(err)
	}
	inherited := filepath.Join(filepath.Dir(w.Path), "AGENTS.md")
	if err := os.WriteFile(inherited, []byte("Parent guidance"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveResource(ResourceInput{WorkspaceID: w.ID, Path: inherited, Content: "Overwrite"}); err == nil {
		t.Fatal("inherited resource editable")
	}
	if err := s.SaveResource(ResourceInput{WorkspaceID: w.ID, Kind: "skill", Name: "../escape", Content: "Escape"}); err == nil {
		t.Fatal("unsafe creation name accepted")
	}
}

func TestBranchSwitchPreservesSiblingsAcrossRestart(t *testing.T) {
	s, _, c, dir := productFeatureService(t)
	if err := s.RenameConversation(c.ID, "Branch fixture"); err != nil {
		t.Fatal(err)
	}
	manager, err := codingagent.OpenSession(s.sessionFile(c.ID))
	if err != nil {
		t.Fatal(err)
	}
	appendFeatureMessage(t, manager, aitypes.NewUserMessageVariant(aitypes.NewUserMessage("Question", 1)))
	first := manager.LeafID()
	appendFeatureMessage(t, manager, aitypes.NewUserMessageVariant(aitypes.NewUserMessage("Original follow-up", 2)))
	second := manager.LeafID()
	manager.Close()
	if err := s.BranchConversation(c.ID, first, false); err != nil {
		t.Fatal(err)
	}
	manager, _ = codingagent.OpenSession(s.sessionFile(c.ID))
	appendFeatureMessage(t, manager, aitypes.NewUserMessageVariant(aitypes.NewUserMessage("Alternative follow-up", 3)))
	manager.Close()
	nodes, err := s.History(c.ID)
	if err != nil || len(nodes) != 3 {
		t.Fatalf("lost branch: %+v %v", nodes, err)
	}
	s.Close()
	reopened, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if err := reopened.BranchConversation(c.ID, second, false); err != nil {
		t.Fatal(err)
	}
	if countText(reopened.Snapshot().Messages, "Original follow-up") != 1 || countText(reopened.Snapshot().Messages, "Alternative follow-up") != 0 {
		t.Fatal("branch leaf did not restore")
	}
}

func TestMessageBranchTargetsExcludeToolExchanges(t *testing.T) {
	s, _, conversation, _ := productFeatureService(t)
	manager, err := codingagent.OpenSession(s.sessionFile(conversation.ID))
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	appendFeatureMessage(t, manager, aitypes.NewUserMessageVariant(aitypes.NewUserMessage("Explore the workspace", 1)))
	assistant := aitypes.NewAssistantMessage(aitypes.ApiOpenAICompletions, "fixture", "offline", 2)
	assistant.Content = []aitypes.ContentBlock{aitypes.TextBlock("I'll inspect the files."), aitypes.ToolCallBlock(aitypes.NewToolCall("call", "list_files", json.RawMessage(`{}`)))}
	assistant.StopReason = aitypes.StopReasonToolUse
	appendFeatureMessage(t, manager, aitypes.NewAssistantMessageVariant(assistant))
	callNode := manager.LeafID()
	appendFeatureMessage(t, manager, aitypes.NewToolResultMessageVariant(aitypes.NewToolResultMessage("call", "list_files", []aitypes.ContentBlock{aitypes.TextBlock("README.md")}, false, 3)))
	assistant.Content = []aitypes.ContentBlock{aitypes.TextBlock("The workspace contains README.md.")}
	assistant.StopReason = aitypes.StopReasonStop
	appendFeatureMessage(t, manager, aitypes.NewAssistantMessageVariant(assistant))
	messages := messagesFrom(manager)
	if len(messages) != 4 || messages[0].BranchNodeID != messages[0].ID || messages[3].BranchNodeID != messages[3].ID {
		t.Fatalf("saved user/final messages lost their branch targets: %+v", messages)
	}
	if messages[1].BranchNodeID != "" || messages[2].BranchNodeID != "" {
		t.Fatal("an unfinished tool exchange became an inline branch target")
	}
	if messages[2].ToolCallID != "call" {
		t.Fatal("saved tool result lost the stable ID used for expansion state")
	}
	manager.Close()
	if err := s.BranchConversation(conversation.ID, callNode, false); err == nil {
		t.Fatal("the service accepted a branch into an unfinished tool exchange")
	}
}

func TestModelOAuthPromptsPersistCredentialsWithoutExposingThem(t *testing.T) {
	s, _, _, dir := productFeatureService(t)
	login := func(ctx context.Context, interaction authtypes.ProviderAuthInteraction) (*authtypes.OAuthCredential, error) {
		url := "https://accounts.example/authorize"
		interaction.Notify(authtypes.AuthEvent{URL: &url})
		answer, err := interaction.Prompt(ctx, authtypes.AuthPrompt{Type: "secret", Message: "Paste fixture code"})
		if err != nil {
			return nil, err
		}
		if answer != "fixture-code" {
			t.Error("wrong answer")
		}
		return authtypes.NewOAuthCredential("private-refresh", "private-access", float64(time.Now().Add(time.Hour).UnixMilli())), nil
	}
	if err := s.startOAuth("anthropic", login); err != nil {
		t.Fatal(err)
	}
	state := waitState(t, s, func(st State) bool { return st.Login != nil && st.Login.Phase == "prompt" })
	if err := s.AnswerOAuth("stale", "bad"); err == nil {
		t.Fatal("stale prompt accepted")
	}
	if err := s.AnswerOAuth(state.Login.ID, "fixture-code"); err != nil {
		t.Fatal(err)
	}
	state = waitState(t, s, func(st State) bool { return st.Login.Phase == "complete" })
	encoded, _ := json.Marshal(state)
	if strings.Contains(string(encoded), "private-") {
		t.Fatal("credential leaked to UI")
	}
	saved, err := os.ReadFile(filepath.Join(dir, "auth.json"))
	if err != nil || !strings.Contains(string(saved), "private-access") {
		t.Fatal("SDK credential store not persisted")
	}
	info, _ := os.Stat(filepath.Join(dir, "auth.json"))
	if info.Mode().Perm() != 0600 {
		t.Fatal("auth file permissions")
	}
	if err := s.LogoutOAuth("anthropic"); err != nil {
		t.Fatal(err)
	}
	saved, _ = os.ReadFile(filepath.Join(dir, "auth.json"))
	if strings.Contains(string(saved), "private-access") {
		t.Fatal("sign-out left tokens")
	}
	for _, bad := range []string{"javascript:alert(1)", "http://example.com", "https://user:password@example.com"} {
		if safeLoginURL(bad) != "" {
			t.Fatal("unsafe login URL accepted")
		}
	}
}

func TestDurableAdmissionQueueRecoveryPaginationAndDeletion(t *testing.T) {
	s, w, c, dir := productFeatureService(t)
	model, err := resolveConfiguredModel(s.config)
	if err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	journal, err := s.active.admitDurableLocked(c.ID, w, s.config, model, durableInput{Text: "Admitted but not started", RunID: "fixture"})
	if err == nil {
		s.active.durable = journal
	}
	s.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	err = journal.harness.CommitConversation(context.Background(), journal.conversation, func(tx *durable.Transaction) error {
		for i := 0; i < 300; i++ {
			if _, err := tx.AppendEntry(context.Background(), journal.conversation, durable.EntryDraft{Kind: "fixture", Data: json.RawMessage(`{}`)}); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	image := aitypes.ImageContent{Type: "image", MimeType: "image/png", Data: "fixture-image"}
	s.mu.Lock()
	err = s.active.durableQueueLocked("desk.queue", QueuedMessage{ID: "pending", Text: "Afterward", Mode: QueueFollowUp, Images: []aitypes.ImageContent{image}, ImageCount: 1})
	s.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if err := journal.harness.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	s.active.durable = nil
	s.mu.Unlock()
	s.Close()
	reopened, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	state := reopened.Snapshot()
	if state.Failure == nil || state.Failure.Kind != "interrupted" || len(state.QueuedMessages) != 1 || state.QueuedMessages[0].Images[0].Data != "fixture-image" {
		t.Fatalf("durable recovery: %+v", state)
	}
	if reopened.active.recoveredInput == nil || reopened.active.recoveredInput.Text != "Admitted but not started" {
		t.Fatal("original admission lost")
	}
	if state.Running {
		t.Fatal("unsafe task replayed automatically")
	}
	if err := reopened.DeleteConversation(c.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(reopened.durableDir(c.ID)); !os.IsNotExist(err) {
		t.Fatal("durable data left after delete")
	}
}

func TestMCPOAuthTokensAreEndpointScopedAndRedacted(t *testing.T) {
	s, _, _, _ := productFeatureService(t)
	connector := newDeskMCPFixture(t, "private-oauth-token", nil)
	input := MCPInput{Name: "oauth-fixture", Type: "http", URL: connector.server.URL, OAuth: true, Enabled: true}
	if err := s.SaveMCP(input); err != nil {
		t.Fatal(err)
	}
	config := s.mcpConfigs[0]
	expiry := time.Now().Add(time.Hour).UnixMilli()
	if err := s.mcpOAuthStore(config).Save(mcp.McpOAuthState{ServerURL: config.URL, Tokens: &mcp.OAuthTokens{AccessToken: "private-oauth-token", RefreshToken: "private-refresh"}, TokensExpireAt: &expiry}); err != nil {
		t.Fatal(err)
	}
	if err := s.ConnectMCP(context.Background()); err != nil {
		t.Fatal(err)
	}
	list := s.ListMCP()
	if !list[0].SignedIn || list[0].Status != "connected" {
		t.Fatalf("OAuth MCP: %+v", list)
	}
	s.mu.Lock()
	redacted := s.redactMCPLocked("private-oauth-token private-refresh")
	s.mu.Unlock()
	if strings.Contains(redacted, "private-") {
		t.Fatal("OAuth diagnostics leaked tokens")
	}
	input.URL = "https://different.example/mcp"
	if err := s.SaveMCP(input); err != nil {
		t.Fatal(err)
	}
	if s.ListMCP()[0].SignedIn {
		t.Fatal("OAuth token crossed endpoints")
	}
	if _, err := os.Stat(s.mcpOAuthStore(config).path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("Obsolete OAuth credential file was retained")
	}
}

func TestMCPOAuthSDKFlowValidatesCallbackAndCancels(t *testing.T) {
	var base string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource":
			_ = json.NewEncoder(w).Encode(map[string]any{"resource": base + "/mcp", "authorization_servers": []string{base}})
		case "/.well-known/oauth-authorization-server", "/.well-known/openid-configuration":
			_ = json.NewEncoder(w).Encode(map[string]any{"issuer": base, "authorization_endpoint": "https://auth.fixture.example/authorize", "token_endpoint": base + "/token", "registration_endpoint": base + "/register", "response_types_supported": []string{"code"}, "code_challenge_methods_supported": []string{"S256"}, "token_endpoint_auth_methods_supported": []string{"none"}})
		case "/register":
			_ = json.NewEncoder(w).Encode(map[string]any{"client_id": "fixture-client", "token_endpoint_auth_method": "none", "redirect_uris": []string{mcpCallbackURL}})
		case "/token":
			if err := r.ParseForm(); err != nil || r.Form.Get("code") != "fixture-code" || r.Form.Get("code_verifier") == "" {
				http.Error(w, "invalid PKCE exchange", 400)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "fixture-access", "refresh_token": "fixture-refresh", "token_type": "Bearer", "expires_in": 3600})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	base = server.URL
	s, _, _, _ := productFeatureService(t)
	input := MCPInput{Name: "oauth-flow", Type: "http", URL: base + "/mcp", OAuth: true}
	if err := s.SaveMCP(input); err != nil {
		t.Fatal(err)
	}
	if err := s.StartMCPOAuth(input.Name); err != nil {
		if strings.Contains(err.Error(), "port 54819 is busy") {
			t.Skip(err)
		}
		t.Fatal(err)
	}
	state := waitState(t, s, func(st State) bool { return st.Login != nil && (st.Login.URL != "" || st.Login.Phase == "error") })
	if state.Login.Phase == "error" {
		t.Fatalf("SDK OAuth discovery: %+v", state.Login)
	}
	authorization, err := url.Parse(state.Login.URL)
	if err != nil || authorization.Query().Get("code_challenge") == "" {
		t.Fatalf("Missing PKCE challenge: %v", err)
	}
	response, err := http.Get(mcpCallbackURL + "?code=fixture-code&state=wrong")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusBadRequest {
		t.Fatal("Invalid OAuth state accepted")
	}
	callback := mcpCallbackURL + "?code=fixture-code&state=" + url.QueryEscape(authorization.Query().Get("state"))
	response, err = http.Get(callback)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("Callback: %d", response.StatusCode)
	}
	state = waitState(t, s, func(st State) bool { return st.Login.Phase == "complete" || st.Login.Phase == "error" })
	if state.Login.Phase != "complete" || !s.ListMCP()[0].SignedIn {
		t.Fatalf("OAuth exchange: %+v", state.Login)
	}
	if err := s.LogoutMCPOAuth(input.Name); err != nil {
		t.Fatal(err)
	}
	// Completion notification can precede the callback server's deferred close.
	<-s.loginDone
	if err := s.StartMCPOAuth(input.Name); err != nil {
		t.Fatal(err)
	}
	waitState(t, s, func(st State) bool { return st.Login.URL != "" || st.Login.Phase == "error" })
	s.CancelOAuth()
	<-s.loginDone
	if s.Snapshot().Login.Phase != "error" || s.ListMCP()[0].SignedIn {
		t.Fatal("Cancelled login retained credentials")
	}
}

func TestDurableShutdownPreservesQueueAndRequiresReviewedContinuation(t *testing.T) {
	var calls atomic.Int64
	started := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		startSSE(w)
		if calls.Add(1) == 1 {
			w.(http.Flusher).Flush()
			close(started)
			<-r.Context().Done()
			return
		}
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": "continued"}}}})
		finishSSE(w, "stop")
	}))
	defer server.Close()
	s, _, conversation, data := productFeatureService(t)
	if err := s.SaveCustomConnection(customFixture("custom-recovery", server.URL, "fixture")); err != nil {
		t.Fatal(err)
	}
	if err := s.SelectModel("custom-recovery", "fixture", "off"); err != nil {
		t.Fatal(err)
	}
	if err := s.Send("initial request"); err != nil {
		t.Fatal(err)
	}
	<-started
	if err := s.QueueMessage(conversation.ID, "pending follow-up", string(QueueFollowUp)); err != nil {
		t.Fatal(err)
	}
	s.Close()
	reopened, err := New(data)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	state := reopened.Snapshot()
	if state.Running || state.Failure == nil || state.Failure.Kind != "interrupted" || len(state.QueuedMessages) != 1 || calls.Load() != 1 {
		t.Fatalf("Recovery: %+v, requests %d", state.Failure, calls.Load())
	}
	if err := reopened.ContinueTask(conversation.ID); err != nil {
		t.Fatal(err)
	}
	state = waitState(t, reopened, func(st State) bool { return !st.Running })
	if state.Failure != nil || len(state.QueuedMessages) != 0 || calls.Load() != 3 {
		t.Fatalf("Reviewed continuation: %+v, requests %d", state.Failure, calls.Load())
	}
	found := false
	for _, message := range state.Messages {
		found = found || message.Text == "pending follow-up"
	}
	if !found {
		t.Fatal("Recovered follow-up was not consumed")
	}
}
