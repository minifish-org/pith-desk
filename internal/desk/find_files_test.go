package desk

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	codingagent "github.com/minifish-org/pith/packages/coding-agent"
)

func TestFindFilesMatchesUnicodeAndGlobSyntax(t *testing.T) {
	s, workspace, dir := configuredService(t, "http://127.0.0.1:1")
	for _, name := range []string{"报告.md", "café.txt", "docs/报告二.md", "docs/café.txt", "literal*.txt"} {
		path := filepath.Join(workspace, name)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	policy, err := newFilePolicy(workspace, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer policy.root.Close()
	registry, err := s.buildTools(policy)
	if err != nil {
		t.Fatal(err)
	}
	defer registry.CloseTools()
	for _, tc := range []struct{ pattern, want string }{
		{"报告*.md", "报告.md"}, {"caf?.txt", "café.txt"}, {"café.txt", "café.txt"},
		{"docs/**/报告?.md", "报告二.md"}, {"**/caf[é].txt", "café.txt"}, {`literal\*.txt`, "literal*.txt"},
	} {
		t.Run(tc.pattern, func(t *testing.T) {
			args, _ := json.Marshal(map[string]string{"pattern": tc.pattern})
			result, err := registry.Execute(context.Background(), codingagent.ToolCall{ID: "find", Name: "find_files", Arguments: args})
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(blockText(result.Content), tc.want) {
				t.Fatalf("existing file %q not found: %s", tc.want, blockText(result.Content))
			}
		})
	}
}
