package desk

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	aitypes "github.com/minifish-org/pith/packages/ai/types"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
)

func TestPatchLineCountsIgnoreHeadersAndContext(t *testing.T) {
	patch := "--- a/note.txt\n+++ b/note.txt\n@@ -1,3 +1,4 @@\n context\n-removed\n+added\n+another\n@@ -10 +11 @@\n--- content that looks like a header\n+++ content that looks like a header\n\\ No newline at end of file\n"
	additions, deletions := patchLineCounts(patch)
	if additions != 3 || deletions != 2 {
		t.Fatalf("patch counts = +%d -%d", additions, deletions)
	}
	if additions, deletions = patchLineCounts(""); additions != 0 || deletions != 0 {
		t.Fatalf("empty patch counts = +%d -%d", additions, deletions)
	}
}

func TestWriteChangeStatsRecordReplacementTotals(t *testing.T) {
	s, workspace, _, _ := productFeatureService(t)
	policy, err := newFilePolicy(workspace.Path, s.dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer policy.root.Close()
	if err := os.WriteFile(filepath.Join(workspace.Path, "note.txt"), []byte("one\ntwo\nthree\n"), 0644); err != nil {
		t.Fatal(err)
	}
	write := func(ctx context.Context, arguments json.RawMessage) (codingagent.ToolResult, error) {
		var input struct {
			Path    string `json:"path"`
			Content string `json:"content"`
		}
		if err := json.Unmarshal(arguments, &input); err != nil {
			return codingagent.ToolResult{}, err
		}
		if err := os.WriteFile(filepath.Join(workspace.Path, input.Path), []byte(input.Content), 0644); err != nil {
			return codingagent.ToolResult{}, err
		}
		return codingagent.ToolResult{Content: []aitypes.ContentBlock{aitypes.TextBlock("ok")}}, nil
	}
	definition := withWriteChangeStats(policy, codingagent.ToolDefinition{Name: "write_file", Execute: write})
	result, err := definition.Execute(context.Background(), json.RawMessage(`{"path":"note.txt","content":"one\nchanged\nthree\nfour\n"}`))
	if err != nil {
		t.Fatal(err)
	}
	var details fileChangeDetails
	if err := json.Unmarshal(result.Details, &details); err != nil {
		t.Fatal(err)
	}
	if details.Additions != 2 || details.Deletions != 1 {
		t.Fatalf("replacement stats = %+v", details)
	}
	if !strings.Contains(details.Patch, "-two") || !strings.Contains(details.Patch, "+changed") {
		t.Fatalf("replacement patch = %q", details.Patch)
	}

	result, err = definition.Execute(context.Background(), json.RawMessage(`{"path":"created.txt","content":"first\nsecond"}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(result.Details, &details); err != nil {
		t.Fatal(err)
	}
	if details.Additions != 2 || details.Deletions != 0 {
		t.Fatalf("creation stats = %+v", details)
	}
	if !strings.Contains(details.Patch, "+first") || details.PatchTruncated {
		t.Fatalf("creation patch = %q", details.Patch)
	}
}

func TestClipUTF8DoesNotSplitRunes(t *testing.T) {
	value := "abc中"
	if clipped := clipUTF8(value, 4); clipped != "abc" {
		t.Fatalf("clipped = %q", clipped)
	}
	if clipped := clipUTF8(value, 6); clipped != value {
		t.Fatalf("whole value = %q", clipped)
	}
}
