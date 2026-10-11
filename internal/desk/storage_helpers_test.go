package desk

import (
	"github.com/minifish-org/pith-desk/internal/localstore"
	"github.com/minifish-org/pith-desk/internal/workspacefs"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
)

func readJSON(path string, target any) error { return (localstore.Store{}).ReadJSON(path, target) }
func writeJSON(path string, value any) error { return (localstore.Store{}).WriteJSON(path, value) }

func readDraft(path string) (Draft, error) { return (DraftStore{}).read(path) }

func validateRuntimeResources(workspace, private string) error {
	return workspacefs.ValidateResources(workspace, private, codingagent.ConfigDirName)
}
