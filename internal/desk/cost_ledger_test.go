package desk

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/minifish-org/pith-desk/internal/localstore"
	"github.com/minifish-org/pith-desk/internal/testsupport/filefault"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
)

func TestCostLedgerAppendFailuresRemainUnavailable(t *testing.T) {
	for _, stage := range []string{"mkdir", "open", "write", "sync", "close"} {
		t.Run(stage, func(t *testing.T) {
			s, dir, _ := fixedPersistenceService(t)
			path := filepath.Join(dir, "costs/fixture-conversation.jsonl")
			old, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			before := s.Snapshot().Runtime.Cost
			s.files = localstore.Store{FS: &filefault.FS{Step: stage}}
			t.Cleanup(func() { s.files = localstore.Store{} })
			s.recordCost("fixture-conversation", "fixture-run", "agent", &aitypes.Model{Id: "deepseek-flash", Provider: "deepseek", Cost: aitypes.ModelCost{Input: 1, Output: 2}}, s.config, aitypes.AssistantMessage{Usage: aitypes.Usage{Input: 1, Output: 1, TotalTokens: 2}})
			state := s.Snapshot()
			if !state.Runtime.Cost.Unavailable || !strings.Contains(state.Error, "injected storage failure") || state.Runtime.Cost.RequestCount != before.RequestCount || state.Runtime.Cost.Total != before.Total {
				t.Fatalf("failed append counted as successful/free: %+v", state.Runtime.Cost)
			}
			written, err := os.ReadFile(path)
			if err != nil || !bytes.HasPrefix(written, old) {
				t.Fatalf("previous ledger commit damaged: %v", err)
			}
			if stage == "write" {
				if _, err := s.Costs("fixture-conversation"); err == nil {
					t.Fatal("partial append tail silently treated as valid/zero")
				}
			}
		})
	}
}
