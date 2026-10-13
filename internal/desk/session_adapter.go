package desk

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/minifish-org/pith-desk/internal/workspacefs"
	agenttypes "github.com/minifish-org/pith/packages/agent/types"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
)

// SessionAdapter is a thin SDK boundary. It has no catalog, runtime or cache;
// the application coordinates commits involving index and receipt files.
type SessionAdapter struct{ dataDir string }

func (s *Service) sessionAdapter() SessionAdapter { return SessionAdapter{dataDir: s.dataDir} }
func (a SessionAdapter) file(id string) string {
	return filepath.Join(a.dataDir, "sessions", id+".jsonl")
}
func (a SessionAdapter) open(id, cwd string) (*codingagent.SessionManager, error) {
	return openDeskSession(a.file(id), id, cwd)
}

// Reading an older empty conversation must not create a new persisted session.
func (a SessionAdapter) read(id string) (*codingagent.SessionManager, error) {
	info, err := os.Stat(a.file(id))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("Conversation session is not a regular file")
	}
	if info.Size() == 0 {
		return nil, nil
	}
	return codingagent.OpenSession(a.file(id))
}

// The pinned SDK has no public Cwd option on OpenSession. Seed only a missing
// or historical zero-byte session with its exported header type, then let Pith
// own all parsing and subsequent records. Existing transcripts stay untouched.
func openDeskSession(file, id, cwd string) (*codingagent.SessionManager, error) {
	info, err := os.Stat(file)
	if err == nil && info.Size() > 0 {
		return codingagent.OpenSession(file)
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err == nil && !info.Mode().IsRegular() {
		return nil, errors.New("Conversation session is not a regular file")
	}
	canonical, err := workspacefs.Directory(cwd)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		return nil, err
	}
	version := codingagent.CurrentSessionVersion
	header, err := json.Marshal(codingagent.SessionHeader{Type: "session", Version: &version, ID: id, Timestamp: timestamp(), Cwd: canonical})
	if err != nil {
		return nil, err
	}
	flags := os.O_WRONLY | os.O_CREATE | os.O_EXCL
	if info != nil {
		flags = os.O_WRONLY | os.O_TRUNC
	}
	output, err := os.OpenFile(file, flags, 0600)
	if errors.Is(err, os.ErrExist) {
		return codingagent.OpenSession(file)
	}
	if err != nil {
		return nil, err
	}
	_, writeErr := output.Write(append(header, '\n'))
	if writeErr == nil {
		writeErr = output.Sync()
	}
	closeErr := output.Close()
	if writeErr != nil {
		return nil, writeErr
	}
	if closeErr != nil {
		return nil, closeErr
	}
	return codingagent.OpenSession(file)
}

// A Pith session_info record is the authority for the display name. The catalog
// is only an index, including for older conversations with no session yet.
func latestSessionTitle(manager *codingagent.SessionManager, fallback string) string {
	if manager != nil {
		entries := manager.Entries()
		for i := len(entries) - 1; i >= 0; i-- {
			if entries[i].Type != "session_info" {
				continue
			}
			var info struct {
				Name string `json:"name"`
			}
			if json.Unmarshal(entries[i].Payload, &info) == nil && strings.TrimSpace(info.Name) != "" {
				return info.Name
			}
		}
	}
	return fallback
}

func ensureSessionTitle(manager *codingagent.SessionManager, fallback string) error {
	if manager == nil || strings.TrimSpace(fallback) == "" {
		return nil
	}
	if latestSessionTitle(manager, "") != "" {
		return nil
	}
	_, err := manager.AppendSessionInfo(fallback)
	return err
}

func messagesFrom(manager *codingagent.SessionManager) []Message {
	messages := []Message{}
	commands := map[string]*CommandDetails{}
	// Context is the complete active branch. BuildContextEntries is the model's
	// compacted view and would hide older messages from the user's history.
	for _, entry := range manager.Context() {
		if entry.Type != "message" {
			continue
		}
		var message agenttypes.AgentMessage
		if json.Unmarshal(entry.Payload, &message) != nil || message.Message == nil {
			continue
		}
		msg := message.Message
		out := Message{ID: entry.ID, Role: msg.Role}
		switch {
		case msg.User != nil:
			out.Timestamp = msg.User.Timestamp
			out.Text = msg.User.Content.Text + blockText(msg.User.Content.Blocks)
			out.Images = messageImages(msg.User.Content.Blocks)
			out.BranchNodeID = entry.ID
		case msg.Assistant != nil:
			out.Timestamp = msg.Assistant.Timestamp
			out.Text = blockText(msg.Assistant.Content)
			out.BranchNodeID = entry.ID
			for _, block := range msg.Assistant.Content {
				if block.IsToolCall() {
					out.BranchNodeID = ""
					if command := commandDetailsForCall(block.ToolCall.Name, block.ToolCall.Arguments, manager.GetCwd()); command != nil {
						commands[block.ToolCall.Id] = command
					}
				}
			}
			if msg.Assistant.StopReason == aitypes.StopReasonError || msg.Assistant.StopReason == aitypes.StopReasonAborted {
				out.Status = "error"
			}
		case msg.ToolResult != nil:
			out.Role, out.ToolName = "tool", msg.ToolResult.ToolName
			out.ToolCallID = msg.ToolResult.ToolCallId
			out.Text, out.Status = blockText(msg.ToolResult.Content), "done"
			out.Images = messageImages(msg.ToolResult.Content)
			if out.ToolName == "run_command" {
				out.Command = cloneCommandDetails(commands[out.ToolCallID])
				applyCommandResult(out.Command, msg.ToolResult.Details)
			}
			if msg.ToolResult.IsError {
				out.Status = "error"
			}
		}
		if out.Text != "" || len(out.Images) > 0 || out.Role == "tool" {
			messages = append(messages, out)
		}
	}
	return messages
}

func blockText(blocks []aitypes.ContentBlock) string {
	var text strings.Builder
	for _, block := range blocks {
		if block.Text != nil {
			text.WriteString(block.Text.Text)
		}
	}
	return text.String()
}

func sessionHistory(manager *codingagent.SessionManager) []HistoryNode {
	nodes := []HistoryNode{}
	if manager == nil {
		return nodes
	}
	active := map[string]bool{}
	for _, entry := range manager.Context() {
		active[entry.ID] = true
	}
	for _, entry := range manager.Entries() {
		if entry.Type != "message" {
			continue
		}
		var message agenttypes.AgentMessage
		if json.Unmarshal(entry.Payload, &message) != nil || message.Message == nil {
			continue
		}
		m := message.Message
		node := HistoryNode{ID: entry.ID, ParentID: entry.ParentID, Role: m.Role, Active: active[entry.ID]}
		if m.User != nil {
			node.Text = m.User.Content.Text + blockText(m.User.Content.Blocks)
		}
		if m.Assistant != nil {
			// Only settled replies are branch targets. A half tool exchange
			// must never become the end of a provider's next transcript.
			hasCall := false
			for _, block := range m.Assistant.Content {
				hasCall = hasCall || block.IsToolCall()
			}
			if hasCall {
				continue
			}
			node.Text = blockText(m.Assistant.Content)
		}
		if m.User != nil || m.Assistant != nil {
			nodes = append(nodes, node)
		}
	}
	return nodes
}

func branchSession(manager *codingagent.SessionManager, nodeID string, before bool) error {
	target := ""
	found := false
	for _, entry := range manager.Entries() {
		if entry.ID != nodeID || entry.Type != "message" {
			continue
		}
		var message agenttypes.AgentMessage
		if json.Unmarshal(entry.Payload, &message) != nil || message.Message == nil {
			break
		}
		m := message.Message
		if before && m.User == nil {
			break
		}
		if m.Assistant != nil {
			for _, block := range m.Assistant.Content {
				if block.IsToolCall() {
					return errors.New("Select a user message or a completed reply")
				}
			}
		}
		if m.User == nil && m.Assistant == nil {
			break
		}
		found = true
		target = entry.ID
		if before {
			target = entry.ParentID
		}
		break
	}
	if !found {
		return errors.New("History node not found")
	}
	return manager.Branch(target)

}
