package desk

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
	"unicode/utf8"

	codingagent "github.com/minifish-org/pith/packages/coding-agent"
)

const maxApprovalFileBytes = 64 << 10
const maxApprovalLines = 2000

type ApprovalPreview struct {
	Path      string `json:"path"`
	Kind      string `json:"kind"`
	Diff      string `json:"diff,omitempty"`
	Error     string `json:"error,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
}

type approvalFileReview struct {
	policy *filePolicy
	path   string
	exists bool
	digest [32]byte
}

func approvalFileContent(policy *filePolicy, path string) ([]byte, bool, error) {
	if _, err := policy.checked(path); err != nil {
		return nil, false, err
	}
	file, err := policy.openRegular(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxApprovalFileBytes+1))
	if err != nil {
		return nil, true, err
	}
	if len(data) > maxApprovalFileBytes || !utf8.Valid(data) || strings.ContainsRune(string(data), 0) || strings.Count(string(data), "\n") > maxApprovalLines {
		return nil, true, errors.New("This file is too large or is not text. Review the tool arguments")
	}
	return data, true, nil
}

func fileApprovalPreview(policy *filePolicy, tool string, args json.RawMessage) (*ApprovalPreview, *approvalFileReview) {
	var in struct {
		Path    string             `json:"path"`
		Content string             `json:"content"`
		Edits   []codingagent.Edit `json:"edits"`
	}
	if err := json.Unmarshal(args, &in); err != nil || in.Path == "" {
		return &ApprovalPreview{Error: "Could not preview these tool arguments"}, nil
	}
	preview := &ApprovalPreview{Path: in.Path, Kind: "modify"}
	before, exists, err := approvalFileContent(policy, in.Path)
	if err != nil {
		preview.Error = err.Error()
		return preview, nil
	}
	if !exists {
		preview.Kind = "create"
	}
	originalDigest := sha256.Sum256(before)
	after := in.Content
	if tool == "edit_file" {
		if !exists {
			preview.Error = "The file to edit does not exist"
			return preview, nil
		}
		original := codingagent.NormalizeToLF(strings.TrimPrefix(string(before), "\ufeff"))
		// Apply the same matching and multi-edit validation as the SDK tool.
		editBytes := 0
		for _, edit := range in.Edits {
			editBytes += len(edit.NewText) + len(edit.OldText)
			if editBytes > maxApprovalFileBytes || len(in.Edits) > 128 {
				preview.Error = "This change is too large to preview. Review the tool arguments"
				return preview, nil
			}
		}
		applied, applyErr := codingagent.ApplyEditsToNormalizedContent(original, in.Edits, in.Path)
		if applyErr != nil {
			preview.Error = applyErr.Error()
			return preview, nil
		}
		before, after = []byte(applied.BaseContent), applied.NewContent
	}
	if len(after) > maxApprovalFileBytes || !utf8.ValidString(after) || strings.ContainsRune(after, 0) || strings.Count(after, "\n") > maxApprovalLines {
		preview.Error = "This change is too large to preview. Review the tool arguments"
		return preview, nil
	}
	preview.Diff = codingagent.GenerateUnifiedPatch(in.Path, string(before), after)
	if len(preview.Diff) > maxApprovalFileBytes {
		preview.Diff = preview.Diff[:maxApprovalFileBytes]
		for !utf8.ValidString(preview.Diff) {
			preview.Diff = preview.Diff[:len(preview.Diff)-1]
		}
		preview.Truncated = true
	}
	// Keep the original bytes for freshness checks (not normalized diff text).
	raw, stillExists, readErr := approvalFileContent(policy, in.Path)
	if readErr != nil || stillExists != exists || sha256.Sum256(raw) != originalDigest {
		preview.Error, preview.Diff = "The file changed while preparing its preview. Review again", ""
		return preview, nil
	}
	return preview, &approvalFileReview{policy: policy, path: in.Path, exists: exists, digest: originalDigest}
}

func (review *approvalFileReview) unchanged() bool {
	data, exists, err := approvalFileContent(review.policy, review.path)
	return err == nil && exists == review.exists && sha256.Sum256(data) == review.digest
}
