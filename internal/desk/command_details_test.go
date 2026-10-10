package desk

import (
	"encoding/json"
	"strings"
	"testing"

	agenttypes "github.com/minifish-org/pith/packages/agent/types"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
)

func appendCommandCalls(t *testing.T, manager *codingagent.SessionManager, calls ...aitypes.ToolCall) {
	t.Helper()
	assistant := aitypes.NewAssistantMessage(aitypes.ApiOpenAICompletions, "fixture", "offline", 1)
	assistant.StopReason = aitypes.StopReasonToolUse
	for _, call := range calls {
		assistant.Content = append(assistant.Content, aitypes.ToolCallBlock(call))
	}
	appendFeatureMessage(t, manager, aitypes.NewAssistantMessageVariant(assistant))
}

func TestCommandDetailsLiveAndReopenedHistory(t *testing.T) {
	s, workspace, conversation, dataDir := productFeatureService(t)
	manager, err := openDeskSession(s.sessionFile(conversation.ID), conversation.ID, workspace.Path)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	text := "printf '%s\\n' '<note>'\nls -l"
	arguments, _ := json.Marshal(map[string]string{"command": text, "cwd": "/ignored-argument", "env": "hidden-input"})
	appendCommandCalls(t, manager, aitypes.NewToolCall("command-call", "run_command", arguments))
	s.active.observe(codingagent.SessionEvent{Type: codingagent.SessionEventToolExecutionStart, ToolName: "run_command", ToolCallID: "command-call"}, manager)
	live := s.Snapshot().Messages
	if len(live) != 1 || live[0].Status != "running" || live[0].Command == nil {
		t.Fatalf("live command metadata missing: %+v", live)
	}
	if live[0].Command.Text != text || live[0].Command.Cwd != workspace.Path || live[0].Command.ExitCode != nil {
		t.Fatalf("wrong live command plan: %+v", live[0].Command)
	}
	live[0].Command.Text = "changed snapshot"
	if s.Snapshot().Messages[0].Command.Text != text {
		t.Fatal("snapshot command metadata shares mutable runtime state")
	}

	result := aitypes.NewToolResultMessage("command-call", "run_command", []aitypes.ContentBlock{aitypes.TextBlock("<note>\nREADME.md")}, false, 2)
	result.Details = json.RawMessage(`{"exitCode":0,"env":{"TOKEN":"hidden-result"},"fullOutputPath":"private-spill-path"}`)
	agentMessage := agenttypes.NewAgentMessageFromMessage(aitypes.NewToolResultMessageVariant(result))
	s.active.observe(codingagent.SessionEvent{Type: codingagent.SessionEventToolExecutionEnd, ToolName: "run_command", ToolCallID: "command-call", Message: &agentMessage}, manager)
	completed := s.Snapshot().Messages[0]
	if completed.Status != "done" || completed.Text != "<note>\nREADME.md" || completed.Command.ExitCode == nil || *completed.Command.ExitCode != 0 {
		t.Fatalf("live completion lost command outcome: %+v", completed)
	}
	*completed.Command.ExitCode = 91
	if *s.Snapshot().Messages[0].Command.ExitCode != 0 {
		t.Fatal("snapshot exit code shares mutable runtime state")
	}
	appendFeatureMessage(t, manager, aitypes.NewToolResultMessageVariant(result))
	manager.Close()
	s.Close()
	reopened, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	history := reopened.Snapshot().Messages
	if len(history) != 1 || history[0].ToolCallID != "command-call" || history[0].Command == nil {
		t.Fatalf("reopened command pairing lost: %+v", history)
	}
	command := history[0].Command
	if command.Text != text || command.Cwd != workspace.Path || command.ExitCode == nil || *command.ExitCode != 0 {
		t.Fatalf("reopened command outcome changed: %+v", command)
	}
	encoded, _ := json.Marshal(history)
	for _, private := range []string{"hidden-input", "hidden-result", "private-spill-path", "ignored-argument"} {
		if strings.Contains(string(encoded), private) {
			t.Fatalf("command snapshot exposed unrelated metadata %q", private)
		}
	}
}

func TestCommandHistoryPairsMultipleCallsAndKeepsUnknownExit(t *testing.T) {
	s, workspace, conversation, _ := productFeatureService(t)
	manager, err := openDeskSession(s.sessionFile(conversation.ID), conversation.ID, workspace.Path)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	appendCommandCalls(t, manager,
		aitypes.NewToolCall("first", "run_command", json.RawMessage(`{"command":"printf first"}`)),
		aitypes.NewToolCall("read", "read_file", json.RawMessage(`{"command":"not a shell call","path":"README.md"}`)),
		aitypes.NewToolCall("second", "run_command", json.RawMessage(`{"command":"exit 7"}`)),
	)
	for _, result := range []aitypes.ToolResultMessage{
		aitypes.NewToolResultMessage("second", "run_command", []aitypes.ContentBlock{aitypes.TextBlock("Command exited with code 7")}, true, 2),
		aitypes.NewToolResultMessage("first", "run_command", []aitypes.ContentBlock{aitypes.TextBlock("Command exited with code 81")}, false, 3),
		aitypes.NewToolResultMessage("read", "read_file", []aitypes.ContentBlock{aitypes.TextBlock("read result")}, false, 4),
		aitypes.NewToolResultMessage("unpaired", "run_command", nil, false, 5),
	} {
		appendFeatureMessage(t, manager, aitypes.NewToolResultMessageVariant(result))
	}
	messages := messagesFrom(manager)
	if len(messages) != 4 {
		t.Fatalf("unexpected history: %+v", messages)
	}
	if messages[0].Command == nil || messages[0].Command.Text != "exit 7" || messages[0].Status != "error" || messages[0].Command.ExitCode != nil {
		t.Fatalf("failed command was mismatched or exit guessed: %+v", messages[0])
	}
	if messages[1].Command == nil || messages[1].Command.Text != "printf first" || messages[1].Command.Cwd != workspace.Path || messages[1].Command.ExitCode != nil {
		t.Fatalf("successful command was mismatched or output parsed: %+v", messages[1])
	}
	if messages[2].Command != nil || messages[3].Command != nil {
		t.Fatal("non-command or unpaired result gained command metadata")
	}
}

func TestCommandMetadataAllowsOnlyExplicitIntegerExitCodes(t *testing.T) {
	for _, details := range []string{`null`, `{}`, `{"exitCode":null}`, `{"exitCode":"7"}`, `{"exitCode":7.5}`, `{"truncation":{"exitCode":7}}`, `malformed`} {
		command := &CommandDetails{Text: "command", Cwd: "/workspace"}
		applyCommandResult(command, json.RawMessage(details))
		if command.ExitCode != nil {
			t.Fatalf("unknown or invalid exit accepted from %q", details)
		}
	}
	for _, code := range []int{0, 7, -1} {
		details, _ := json.Marshal(map[string]int{"exitCode": code})
		command := &CommandDetails{Text: "command", Cwd: "/workspace"}
		applyCommandResult(command, details)
		if command.ExitCode == nil || *command.ExitCode != code {
			t.Fatalf("explicit exit code %d lost", code)
		}
	}
	for _, arguments := range []string{`{}`, `{"command":0}`, `{"command":"  "}`, `malformed`} {
		if commandDetailsForCall("run_command", json.RawMessage(arguments), "/workspace") != nil {
			t.Fatalf("invalid command arguments accepted: %q", arguments)
		}
	}
}
