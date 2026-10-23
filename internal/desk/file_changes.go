package desk

import (
	"context"
	"encoding/json"
	"strings"
	"unicode/utf8"

	codingagent "github.com/minifish-org/pith/packages/coding-agent"
)

// maxRecordedArtifactPatch bounds the patch kept with a write result so the
// conversation can preview its change without unbounded session growth. Edit
// results already carry the harness patch.
const maxRecordedArtifactPatch = 128 << 10

// fileChangeDetails is the persisted summary of one successful write or edit.
// Edits reuse the harness patch; writes record their own bounded patch.
type fileChangeDetails struct {
	Additions      int    `json:"additions"`
	Deletions      int    `json:"deletions"`
	Patch          string `json:"patch,omitempty"`
	PatchTruncated bool   `json:"patchTruncated,omitempty"`
}

// clipUTF8 bounds stored patch text without splitting a UTF-8 character.
func clipUTF8(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	if len(value) <= limit {
		return value
	}
	value = value[:limit]
	for len(value) > 0 && !utf8.ValidString(value) {
		value = value[:len(value)-1]
	}
	return value
}

// patchLineCounts counts changed lines in a unified patch. File headers and
// hunk context are skipped by counting only after the first hunk: content that
// itself starts with "---" or "+++" must still count.
func patchLineCounts(patch string) (additions, deletions int) {
	inHunk := false
	for _, line := range strings.Split(patch, "\n") {
		if strings.HasPrefix(line, "@@") {
			inHunk = true
			continue
		}
		if !inHunk || line == "" {
			continue
		}
		switch line[0] {
		case '+':
			additions++
		case '-':
			deletions++
		}
	}
	return additions, deletions
}

// withWriteChangeStats records how many lines a write added and removed. The
// write tool replaces the whole file, so the previous content is read before
// execution and the requested content is the new state. Files that cannot be
// read as bounded text keep the tool's original result without a summary.
func withWriteChangeStats(policy *filePolicy, definition codingagent.ToolDefinition) codingagent.ToolDefinition {
	execute := definition.Execute
	definition.Execute = func(ctx context.Context, args json.RawMessage) (codingagent.ToolResult, error) {
		var input struct {
			Path    string `json:"path"`
			Content string `json:"content"`
		}
		if json.Unmarshal(args, &input) != nil || input.Path == "" {
			return execute(ctx, args)
		}
		before, _, err := approvalFileContent(policy, input.Path)
		if err != nil {
			return execute(ctx, args)
		}
		result, execErr := execute(ctx, args)
		if execErr != nil || result.IsError {
			return result, execErr
		}
		patch := codingagent.GenerateUnifiedPatchBounded(input.Path, string(before), input.Content, maxApprovalDiffSteps)
		additions, deletions := patchLineCounts(patch)
		change := fileChangeDetails{Additions: additions, Deletions: deletions}
		if len(patch) > maxRecordedArtifactPatch {
			patch, change.PatchTruncated = clipUTF8(patch, maxRecordedArtifactPatch), true
		}
		change.Patch = patch
		if details, marshalErr := json.Marshal(change); marshalErr == nil {
			result.Details = details
		}
		return result, nil
	}
	return definition
}

// artifactSummary reads the line totals and bounded patch stored with a
// successful write/edit result. Older sessions do not have them.
func artifactSummary(tool string, details json.RawMessage) fileChangeDetails {
	switch tool {
	case "write_file":
		var value fileChangeDetails
		if json.Unmarshal(details, &value) == nil {
			return value
		}
	case "edit_file":
		var value struct {
			Patch string `json:"patch"`
		}
		if json.Unmarshal(details, &value) == nil {
			additions, deletions := patchLineCounts(value.Patch)
			return fileChangeDetails{Additions: additions, Deletions: deletions, Patch: value.Patch}
		}
	}
	return fileChangeDetails{}
}
