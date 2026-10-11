package desk

import (
	"bytes"
	"encoding/json"
	"os"
	"reflect"
	"testing"

	aitypes "github.com/minifish-org/pith/packages/ai/types"
)

// Synthetic state exercises the projection without starting tasks, opening SDK
// sessions or using real credentials. Optional fields can coexist here; this is
// an ownership/serialization test, not a task state-machine fixture.
func snapshotFixtureService() *Service {
	exitCode := 0
	s := &Service{
		connections: Connections{
			config: savedConfig{APIKey: "fixture-private-api-key", AuthPath: "/fixture/private/auth.json"},
			applicationState: applicationState{
				Settings: Settings{
					Provider: "fixture-provider", ModelName: "Fixture Model", Model: "fixture-model",
					ThinkingLevel: "medium", ThinkingLevels: []string{"off", "medium"},
					BaseURL: "http://127.0.0.1:12345/v1", HasConnections: true, HasAPIKey: true,
					Appearance: AppearanceSystem, SupportsImages: true, ImageUploadLimit: MaxImageUploadBytes,
				},
				Login: &LoginStatus{ID: "login-fixture", Provider: "fixture-provider", Phase: "prompt", Message: "Choose an account", URL: "https://example.invalid/login", Code: "FIXTURE-CODE", Prompt: "Account", PromptType: "select", Options: []LoginOption{{ID: "account-a", Label: "Fixture account"}}},
			},
		},
		catalog: Catalog{catalogState: catalogState{
			Workspaces: []Workspace{{ID: "workspace-a", Name: "Fixture A", Path: "/fixture/workspace-a"}, {ID: "workspace-b", Name: "Fixture B", Path: "/fixture/workspace-b"}},
			Conversations: []Conversation{
				{ID: "chat-a", Title: "审查文件", WorkspaceID: "workspace-a", UpdatedAt: "2026-10-11T00:00:00Z", PermissionMode: PermissionAsk, CompletedRunID: "run-previous", Unread: true},
				{ID: "chat-b", Title: "Background", WorkspaceID: "workspace-b", UpdatedAt: "2026-10-11T00:00:00Z", PermissionMode: PermissionWorkspaceWrite},
				{ID: "chat-idle", Title: "Idle", WorkspaceID: "workspace-b", UpdatedAt: "2026-10-11T00:00:00Z", PermissionMode: PermissionFullAccess},
			},
			ActiveID: "chat-a",
		}},
		runtimes: map[string]*conversationRuntime{},
	}
	s.active = &conversationRuntime{service: s, id: "chat-a", workspace: s.catalog.Workspaces[0], ConversationState: &ConversationState{
		Messages: []Message{
			{ID: "message-user", Role: "user", Text: "检查图片", BranchNodeID: "node-user", Images: []MessageImage{{Index: 0, MimeType: "image/png"}}},
			{ID: "message-tool", Role: "tool", Text: "done", ToolName: "run_command", ToolCallID: "call-command", Status: "done", Command: &CommandDetails{Text: "pwd", Cwd: "/fixture/workspace-a", ExitCode: &exitCode}},
		},
		QueuedMessages:  []QueuedMessage{{ID: "queue-a", Text: "下一步", Mode: QueueFollowUp, ImageCount: 1, Images: []aitypes.ImageContent{aitypes.NewImageContent("Zml4dHVyZS1xdWV1ZS1pbWFnZQ==", "image/png")}}},
		Running:         true,
		PendingApproval: &Approval{ID: "approval-a", ToolName: "write_file", Args: json.RawMessage(`{"path":"notes.txt","content":"fixture"}`), Warning: "Review the file", Preview: &ApprovalPreview{Path: "notes.txt", Kind: "create", Diff: "+fixture", Truncated: true}, fileReview: &approvalFileReview{path: "/fixture/private/file-review"}},
		Error:           "The previous request was interrupted.",
		Failure:         &Failure{Kind: "network", Message: "Fixture failure", Advice: "Review before continuing.", CanContinue: true},
		Runtime: RuntimeStatus{
			RunID: "run-a", Provider: "fixture-provider", ThinkingLevel: "medium", Phase: "tool", Model: "fixture-model",
			Usage:         RunUsage{Input: 10, Output: 2, CacheRead: 3, CacheWrite: 4, Total: 19},
			Cost:          CostSummary{Total: 0.25, RunTotal: 0.05, RequestCount: 3, UnknownRequests: 1, RunRequests: 2, RunUnknownRequests: 1, Unavailable: true},
			Timing:        TaskTiming{StartedAt: "2026-10-11T00:00:00Z", ElapsedMs: 1000, OutputTokens: 2, Partial: true},
			ContextTokens: 19, ContextWindow: 1000, Compactions: 1, ToolFailures: 1, UpdatedAt: "2026-10-11T00:00:01Z",
		},
	}}
	s.runtimes["chat-a"] = s.active
	s.runtimes["chat-b"] = &conversationRuntime{service: s, id: "chat-b", workspace: s.catalog.Workspaces[1], ConversationState: &ConversationState{Running: true, Runtime: RuntimeStatus{Phase: "working"}}}
	s.runtimes["chat-idle"] = &conversationRuntime{service: s, id: "chat-idle", ConversationState: &ConversationState{Runtime: RuntimeStatus{Phase: "idle"}}}
	return s
}

func TestSnapshotNestedIsolation(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*State)
	}{
		{"thinking levels", func(v *State) { v.Settings.ThinkingLevels[0] = "changed" }},
		{"workspaces", func(v *State) { v.Workspaces[0].Path = "changed" }},
		{"conversations", func(v *State) { v.Conversations[0].Title = "changed" }},
		{"messages", func(v *State) { v.Messages[0].Text = "changed" }},
		{"message images", func(v *State) { v.Messages[0].Images[0].MimeType = "changed" }},
		{"command details", func(v *State) { v.Messages[1].Command.Text = "changed" }},
		{"command exit code", func(v *State) { *v.Messages[1].Command.ExitCode = 99 }},
		{"queue", func(v *State) { v.QueuedMessages[0].Text = "changed" }},
		{"queue images", func(v *State) { v.QueuedMessages[0].Images[0].Data = "changed" }},
		{"login", func(v *State) { v.Login.Message = "changed" }},
		{"login options", func(v *State) { v.Login.Options[0].Label = "changed" }},
		{"failure", func(v *State) { v.Failure.Advice = "changed" }},
		{"approval", func(v *State) { v.PendingApproval.ToolName = "changed" }},
		{"approval arguments", func(v *State) { v.PendingApproval.Args[2] = 'X' }},
		{"approval preview", func(v *State) { v.PendingApproval.Preview.Diff = "changed" }},
		{"runs", func(v *State) { v.Runs[0].Phase = "changed" }},
		{"runtime values", func(v *State) { v.Runtime.Usage.Input = 99; v.Runtime.Cost.Total = 99; v.Runtime.Timing.ElapsedMs = 99 }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// The oracle owns separate allocations. Taking two snapshots from s
			// would let a shallow-copy bug corrupt both actual and expected.
			s, oracle := snapshotFixtureService(), snapshotFixtureService()
			want := oracle.Snapshot()
			returned := s.Snapshot()
			tc.mutate(&returned)
			if !reflect.DeepEqual(s.connections.applicationState, oracle.connections.applicationState) || !reflect.DeepEqual(s.catalog.catalogState, oracle.catalog.catalogState) || !reflect.DeepEqual(s.active.ConversationState, oracle.active.ConversationState) {
				t.Fatal("mutating the returned snapshot changed its owner")
			}
			if got := s.Snapshot(); !reflect.DeepEqual(got, want) {
				t.Fatalf("mutating the returned snapshot changed the next snapshot:\ngot %#v\nwant %#v", got, want)
			}

			frozen := s.Snapshot()
			s.mu.Lock()
			// Apply the same mutation to the owners, including scalar fields.
			live := State{Settings: s.connections.Settings, Login: s.connections.Login, Workspaces: s.catalog.Workspaces, Conversations: s.catalog.Conversations, ActiveID: s.catalog.ActiveID}
			live.ConversationState = *s.active.ConversationState
			live.Runs = nil
			if tc.name == "runs" {
				s.runtimes["chat-a"].Runtime.Phase = "changed"
			} else {
				tc.mutate(&live)
				s.connections.applicationState = applicationState{Settings: live.Settings, Login: live.Login}
				s.catalog.replace(catalogState{Workspaces: live.Workspaces, Conversations: live.Conversations, ActiveID: live.ActiveID})
				*s.active.ConversationState = live.ConversationState
			}
			s.mu.Unlock()
			if reflect.DeepEqual(s.Snapshot(), want) {
				t.Fatal("owner mutation did not exercise a visible state change")
			}
			if !reflect.DeepEqual(frozen, want) {
				t.Fatal("mutating an owner changed an already returned snapshot")
			}
		})
	}
}

func TestSnapshotPrivateFieldsStayPrivate(t *testing.T) {
	s := snapshotFixtureService()
	snapshot := s.Snapshot()
	if snapshot.PendingApproval.fileReview != nil || s.active.PendingApproval.fileReview == nil {
		t.Fatal("private approval review must stay with its owner, outside the snapshot")
	}
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	for _, private := range []string{s.connections.config.APIKey, s.connections.config.AuthPath, s.active.PendingApproval.fileReview.path, "fileReview", "apiKey"} {
		if bytes.Contains(encoded, []byte(private)) {
			t.Fatalf("public snapshot contains private value or field %q", private)
		}
	}
	if !bytes.Contains(encoded, []byte(`"hasApiKey":true`)) || bytes.Contains(encoded, []byte("Zml4dHVyZS1xdWV1ZS1pbWFnZQ==")) {
		t.Fatal("key presence must stay public; queued image bytes must stay private")
	}
}

func TestSnapshotEmptyNestedValues(t *testing.T) {
	for _, initialized := range []bool{false, true} {
		name := "nil"
		if initialized {
			name = "empty"
		}
		t.Run(name, func(t *testing.T) {
			s := snapshotFixtureService()
			s.connections.Login = &LoginStatus{}
			s.active.PendingApproval = &Approval{}
			s.active.Messages = []Message{{ID: "message-empty", Role: "tool", Command: &CommandDetails{}}}
			s.active.QueuedMessages = []QueuedMessage{{ID: "queue-empty", Mode: QueueFollowUp}}
			if initialized {
				s.connections.Login.Options = []LoginOption{}
				s.active.Messages[0].Images = []MessageImage{}
				s.active.QueuedMessages[0].Images = []aitypes.ImageContent{}
			}
			snapshot := s.Snapshot()
			if snapshot.PendingApproval.Preview != nil || snapshot.PendingApproval.Args != nil || snapshot.Messages[0].Command.ExitCode != nil {
				t.Fatal("absent preview, arguments and exit status must stay absent")
			}
			encoded, err := json.Marshal(snapshot)
			if err != nil {
				t.Fatal(err)
			}
			var fields map[string]json.RawMessage
			if err := json.Unmarshal(encoded, &fields); err != nil {
				t.Fatal(err)
			}
			for field, want := range map[string]string{
				"login":           `{"id":"","provider":"","phase":"","message":""}`,
				"pendingApproval": `{"id":"","toolName":"","args":null}`,
				"messages":        `[{"id":"message-empty","role":"tool","text":"","command":{"text":"","cwd":""}}]`,
				"queuedMessages":  `[{"id":"queue-empty","text":"","mode":"follow-up"}]`,
			} {
				if string(fields[field]) != want {
					t.Fatalf("%s empty JSON changed: got %s, want %s", field, fields[field], want)
				}
			}
		})
	}
}

func TestSnapshotFixedJSON(t *testing.T) {
	for _, name := range []string{"empty", "active", "idle"} {
		t.Run(name, func(t *testing.T) {
			s := snapshotFixtureService()
			switch name {
			case "empty":
				s = &Service{connections: Connections{applicationState: applicationState{Settings: Settings{Appearance: AppearanceSystem, ImageUploadLimit: MaxImageUploadBytes}}}, active: &conversationRuntime{ConversationState: &ConversationState{Runtime: RuntimeStatus{Phase: "idle"}}}}
			case "active":
				s.connections.Login, s.active.Failure, s.active.Error = nil, nil, ""
			case "idle":
				s.active.Running, s.runtimes["chat-b"].Running = false, false
				s.active.PendingApproval = nil
				s.active.Runtime.Phase = "interrupted"
				s.active.Messages = append(s.active.Messages, Message{ID: "message-pending", Role: "tool", Text: "", ToolName: "run_command", ToolCallID: "call-pending", Status: "running", Command: &CommandDetails{Text: "echo fixture", Cwd: "/fixture/workspace-a"}})
				s.active.QueuedMessages = append(s.active.QueuedMessages, QueuedMessage{ID: "queue-steer", Text: "改用摘要", Mode: QueueSteer})
			}
			actual, err := json.Marshal(s.Snapshot())
			if err != nil {
				t.Fatal(err)
			}
			fixed, err := os.ReadFile("testdata/state." + name + ".json")
			if err != nil {
				t.Fatal(err)
			}
			var got, want any
			if err := json.Unmarshal(actual, &got); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(fixed, &want); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("snapshot JSON changed; review compatibility before updating the fixed fixture:\ngot %s\nwant %s", actual, fixed)
			}
		})
	}
}
