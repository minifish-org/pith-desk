package desk

import (
	"encoding/json"
	"path/filepath"

	"github.com/minifish-org/pith-desk/internal/localstore"
)

// CostLedger owns request records and derives summaries from those records.
// Pricing and live task timing belong to their callers. It has no runtime cache.
type CostLedger struct {
	path  string
	files localstore.Store
}

func (ledger CostLedger) read(runID string, includeRun bool) (CostReport, error) {
	report := CostReport{Currency: "USD", Estimated: true, Requests: []RequestCost{}}
	err := ledger.files.ScanJSONL(ledger.path, func(data json.RawMessage) error {
		var record RequestCost
		if err := json.Unmarshal(data, &record); err != nil {
			return err
		}
		report.Requests = append(report.Requests, record)
		report.add(record, includeRun && record.RunID == runID)
		return nil
	})
	return report, err
}
func (ledger CostLedger) ensureDirectory() error {
	return ledger.files.EnsureDirectory(filepath.Dir(ledger.path))
}
func (ledger CostLedger) append(record RequestCost) error {
	return ledger.files.AppendJSONL(ledger.path, record)
}
