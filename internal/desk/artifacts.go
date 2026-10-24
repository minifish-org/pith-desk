package desk

import (
	"encoding/json"
	"errors"
	"path/filepath"

	agenttypes "github.com/minifish-org/pith/packages/agent/types"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
)

type Artifact struct {
	Path      string `json:"path"`
	Name      string `json:"name"`
	Additions int    `json:"additions,omitempty"`
	Deletions int    `json:"deletions,omitempty"`
}

// artifactRecord is one original successful write/edit on the active branch.
// The artifact list aggregates records by path; the diff view keeps each record
// so a file can show its changes in order.
type artifactRecord struct {
	path           string
	additions      int
	deletions      int
	patch          string
	patchTruncated bool
}

func (s *Service) Artifacts(id string) ([]Artifact, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.conversationIdleLocked(id); err != nil {
		return nil, err
	}
	return s.artifactsLocked(id)
}

func (s *Service) artifactsLocked(id string) ([]Artifact, error) {
	records, err := s.artifactRecordsLocked(id)
	if err != nil {
		return nil, err
	}
	artifacts := []Artifact{}
	seen := map[string]bool{}
	totals := map[string]fileChangeDetails{}
	for _, record := range records {
		total := totals[record.path]
		total.Additions += record.additions
		total.Deletions += record.deletions
		totals[record.path] = total
		if seen[record.path] {
			continue
		}
		seen[record.path] = true
		artifacts = append(artifacts, Artifact{Path: record.path, Name: filepath.Base(record.path)})
	}
	for i := range artifacts {
		if total := totals[artifacts[i].Path]; total.Additions != 0 || total.Deletions != 0 {
			artifacts[i].Additions, artifacts[i].Deletions = total.Additions, total.Deletions
		}
	}
	return artifacts, nil
}

func (s *Service) artifactRecordsLocked(id string) ([]artifactRecord, error) {
	index := s.conversationIndexLocked(id)
	if index < 0 {
		return nil, errors.New("Conversation not found")
	}
	workspace, ok := s.workspaceLocked(s.catalog.Conversations[index].WorkspaceID)
	if !ok {
		return nil, errors.New("Workspace not found")
	}
	manager, err := s.readConversationSessionLocked(id)
	if err != nil {
		return nil, err
	}
	records := []artifactRecord{}
	if manager == nil {
		return records, nil
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
	type successfulChange struct {
		callID, path string
		change       fileChangeDetails
	}
	var successes []successfulChange
	for _, entry := range manager.Context() {
		if entry.Type == "custom" {
			var custom struct {
				Type string           `json:"customType"`
				Data nestedFileChange `json:"data"`
			}
			if json.Unmarshal(entry.Payload, &custom) == nil && custom.Type == nestedFileChangeEntry && custom.Data.Path != "" {
				successes = append(successes, successfulChange{path: custom.Data.Path, change: custom.Data.fileChangeDetails})
			}
			continue
		}
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
				successes = append(successes, successfulChange{callID: result.ToolCallId, path: call.path, change: artifactSummary(call.name, result.Details)})
			}
		}
	}
	for _, success := range successes {
		// Reused/replayed IDs cannot identify one original successful operation.
		if id := success.callID; id != "" && (callCounts[id] != 1 || resultCounts[id] != 1) {
			continue
		}
		path, err := policy.CanonicalPath(success.path)
		if err != nil {
			continue
		}
		info, err := policy.stat(path)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		change := success.change
		records = append(records, artifactRecord{
			path: path, additions: change.Additions, deletions: change.Deletions,
			patch: change.Patch, patchTruncated: change.PatchTruncated,
		})
	}
	return records, nil
}

func (s *Service) ResolveArtifactFile(id, path string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.conversationIdleLocked(id); err != nil {
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
