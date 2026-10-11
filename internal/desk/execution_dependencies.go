package desk

import (
	"path/filepath"
	"sync"

	"github.com/minifish-org/pith-desk/internal/localstore"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
)

// Dependencies are injected once per execution. They expose the actual owners
// and immutable paths; callbacks never resolve the currently selected view.
// The shared mutex preserves the application's existing synchronization order.
type executionDependencies struct {
	mu          *sync.Mutex
	closed      *bool
	dataDir     string
	files       *localstore.Store
	catalog     *Catalog
	connections *Connections
	journals    *TaskJournal
	changes     chan<- struct{}
	recordCost  func(string, string, string, *aitypes.Model, savedConfig, aitypes.AssistantMessage)
}

func (s *Service) executionDependencies() executionDependencies {
	return executionDependencies{mu: &s.mu, closed: &s.closed, dataDir: s.dataDir,
		files: &s.files, catalog: &s.catalog, connections: &s.connections,
		journals: &s.journals, changes: s.changes, recordCost: s.recordCost}
}

func (d executionDependencies) changedLocked() {
	select {
	case d.changes <- struct{}{}:
	default:
	}
}

func (d executionDependencies) receiptFile(id string) string {
	return filepath.Join(d.dataDir, "runs", id+".json")
}

func (d executionDependencies) redactMCP(text string) string {
	return d.connections.redactMCP(text, *d.files)
}
