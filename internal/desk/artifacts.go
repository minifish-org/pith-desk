package desk

import (
	"encoding/json"
	"errors"
	"path/filepath"

	agenttypes "github.com/minifish-org/pith/packages/agent/types"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
)

type Artifact struct {
	Path string `json:"path"`
	Name string `json:"name"`
}

func (s *Service) Artifacts(id string) ([]Artifact, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.idleLocked(); err != nil {
		return nil, err
	}
	return s.artifactsLocked(id)
}

func (s *Service) artifactsLocked(id string) ([]Artifact, error) {
	index := s.conversationIndexLocked(id)
	if index < 0 {
		return nil, errors.New("Conversation not found")
	}
	workspace, ok := s.workspaceLocked(s.state.Conversations[index].WorkspaceID)
	if !ok {
		return nil, errors.New("Workspace not found")
	}
	manager, err := s.readConversationSessionLocked(id)
	if err != nil {
		return nil, err
	}
	artifacts := []Artifact{}
	if manager == nil {
		return artifacts, nil
	}
	defer manager.Close()
	policy, err := newFilePolicy(workspace.Path, s.dataDir)
	if err != nil {
		return nil, err
	}
	defer policy.root.Close()
	type candidate struct{ path, name string }
	calls := map[string]candidate{}
	callCounts, resultCounts := map[string]int{}, map[string]int{}
	successes := []string{}
	for _, entry := range manager.Context() {
		if entry.Type != "message" {
			continue
		}
		var message agenttypes.AgentMessage
		if json.Unmarshal(entry.Payload, &message) != nil || message.Message == nil {
			continue
		}
		if assistant := message.Message.Assistant; assistant != nil {
			for _, block := range assistant.Content {
				call := block.ToolCall
				if call == nil || call.Id == "" {
					continue
				}
				callCounts[call.Id]++
				if assistant.StopReason == aitypes.StopReasonError || assistant.StopReason == aitypes.StopReasonAborted || assistant.StopReason == aitypes.StopReasonLength {
					continue
				}
				if call.Name != "write_file" && call.Name != "edit_file" {
					continue
				}
				var args struct {
					Path string `json:"path"`
				}
				if json.Unmarshal(call.Arguments, &args) == nil && args.Path != "" {
					calls[call.Id] = candidate{path: args.Path, name: call.Name}
				}
			}
		}
		if result := message.Message.ToolResult; result != nil {
			resultCounts[result.ToolCallId]++
			call, found := calls[result.ToolCallId]
			if found && !result.IsError && call.name == result.ToolName {
				successes = append(successes, result.ToolCallId)
			}
		}
	}
	seen := map[string]bool{}
	for _, id := range successes {
		// Reused/replayed IDs cannot identify one original successful operation.
		if callCounts[id] != 1 || resultCounts[id] != 1 {
			continue
		}
		path, err := policy.CanonicalPath(calls[id].path)
		if err != nil {
			continue
		}
		info, err := policy.stat(path)
		if err != nil || !info.Mode().IsRegular() || seen[path] {
			continue
		}
		seen[path] = true
		artifacts = append(artifacts, Artifact{Path: path, Name: filepath.Base(path)})
	}
	return artifacts, nil
}

func (s *Service) ResolveArtifactFile(id, path string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.idleLocked(); err != nil {
		return "", err
	}
	artifacts, err := s.artifactsLocked(id)
	if err != nil {
		return "", err
	}
	for _, artifact := range artifacts {
		if artifact.Path == path {
			return artifact.Path, nil
		}
	}
	return "", errors.New("Open a file produced by this conversation inside its workspace")
}
