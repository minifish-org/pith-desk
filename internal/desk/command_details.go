package desk

import (
	"encoding/json"
	"strings"

	agenttypes "github.com/minifish-org/pith/packages/agent/types"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
)

// CommandDetails contains only the built-in shell tool's user-visible plan and
// an explicit process exit code when the SDK supplies one. Environment values
// and unrelated tool result metadata stay out of desktop snapshots.
type CommandDetails struct {
	Text     string `json:"text"`
	Cwd      string `json:"cwd"`
	ExitCode *int   `json:"exitCode,omitempty"`
}

func commandDetailsForCall(name string, arguments json.RawMessage, cwd string) *CommandDetails {
	if name != "run_command" {
		return nil
	}
	var input codingagent.BashToolInput
	if json.Unmarshal(arguments, &input) != nil || strings.TrimSpace(input.Command) == "" {
		return nil
	}
	// Desk's shell tool is bound to the canonical workspace directory and its
	// Prepare callback changes only the environment. An argument named cwd is
	// not part of the tool schema and must not override the actual directory.
	return &CommandDetails{Text: input.Command, Cwd: cwd}
}

func commandDetailsFromSession(manager *codingagent.SessionManager, callID string) *CommandDetails {
	if manager == nil {
		return nil
	}
	entries := manager.Context()
	for i := len(entries) - 1; i >= 0; i-- {
		if entries[i].Type != "message" {
			continue
		}
		var message agenttypes.AgentMessage
		if json.Unmarshal(entries[i].Payload, &message) != nil || message.Message == nil || message.Message.Assistant == nil {
			continue
		}
		for _, block := range message.Message.Assistant.Content {
			if block.IsToolCall() && block.ToolCall.Id == callID {
				return commandDetailsForCall(block.ToolCall.Name, block.ToolCall.Arguments, manager.GetCwd())
			}
		}
	}
	return nil
}

func applyCommandResult(command *CommandDetails, details json.RawMessage) {
	if command == nil {
		return
	}
	var result struct {
		ExitCode *int `json:"exitCode"`
	}
	if json.Unmarshal(details, &result) == nil {
		command.ExitCode = result.ExitCode
	}
	// The pinned Pith shell tool currently returns truncation/spill metadata
	// without exitCode. Do not extract an exit code from output or error text.
}

func cloneCommandDetails(command *CommandDetails) *CommandDetails {
	if command == nil {
		return nil
	}
	copy := *command
	if command.ExitCode != nil {
		code := *command.ExitCode
		copy.ExitCode = &code
	}
	return &copy
}
