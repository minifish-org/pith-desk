package desk

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	aitypes "github.com/minifish-org/pith/packages/ai/types"
)

func TestLargeDraftBoundaryPersistsAndRejectsOverflowWithoutReplacing(t *testing.T) {
	s, _, conversation, _ := productFeatureService(t)
	scope := DraftScope{ID: conversation.ID}
	text := strings.Repeat("中", MaxDraftBytes/3) + strings.Repeat("x", MaxDraftBytes%3)
	if _, err := s.SaveDraft(DraftInput{DraftScope: scope, Draft: Draft{Text: text, Revision: 1}}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SaveDraft(DraftInput{DraftScope: scope, Draft: Draft{Text: text + "x", Revision: 2}}); err == nil {
		t.Fatal("draft overflow accepted")
	}
	got, err := s.Draft(scope)
	if err != nil || got.Text != text || got.Revision != 1 {
		t.Fatal("boundary draft not retained")
	}
}

func TestImageUploadAccepts50MiBAndRejectsOverflow(t *testing.T) {
	data := make([]byte, MaxImageUploadBytes)
	copy(data, []byte("\x89PNG\r\n\x1a\n"))
	image := aitypes.ImageContent{Type: aitypes.ContentTypeImage, MimeType: "image/png", Data: base64.StdEncoding.EncodeToString(data)}
	model := &aitypes.Model{Input: []aitypes.ModelInputModality{aitypes.ModelInputText, aitypes.ModelInputImage}}
	if _, err := validateImages([]aitypes.ImageContent{image}, model); err != nil {
		t.Fatal(err)
	}
	image.Data += "AAAA"
	if _, err := validateImages([]aitypes.ImageContent{image}, model); err == nil {
		t.Fatal("image overflow accepted")
	}
}

func TestLargeApprovalDiffKeepsFreshnessAndReportsDisplayTruncation(t *testing.T) {
	s, workspace, _, _ := productFeatureService(t)
	path := filepath.Join(workspace.Path, "large.txt")
	before := strings.Repeat(strings.Repeat("A", 99)+"\n", 20_000)
	after := strings.Repeat(strings.Repeat("B", 99)+"\n", 20_000)
	if err := os.WriteFile(path, []byte(before), 0600); err != nil {
		t.Fatal(err)
	}
	policy, err := newFilePolicy(workspace.Path, s.dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer policy.root.Close()
	args, _ := json.Marshal(map[string]string{"path": "large.txt", "content": after})
	preview, review := fileApprovalPreview(policy, "write_file", args)
	if preview.Error != "" || !preview.Truncated || len(preview.Diff) > 1<<20 || !utf8.ValidString(preview.Diff) || review == nil || !review.unchanged() {
		t.Fatalf("large approval = error=%s, truncated=%v, bytes=%d", preview.Error, preview.Truncated, len(preview.Diff))
	}
	if err := os.WriteFile(path, []byte("changed after preview"), 0600); err != nil {
		t.Fatal(err)
	}
	if review.unchanged() {
		t.Fatal("large-file freshness check lost")
	}
	args, _ = json.Marshal(map[string]string{"path": "large.txt", "content": strings.Repeat("x\n", maxApprovalLines+1)})
	if preview, _ := fileApprovalPreview(policy, "write_file", args); preview.Error == "" {
		t.Fatal("line overflow accepted")
	}
}
