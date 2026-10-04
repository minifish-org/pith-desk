package host

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/minifish-org/pith-desk/internal/desk"
)

func TestWorkspaceResponseIdentifiesCanonicalExistingWorkspace(t *testing.T) {
	s := testServer(t)
	wanted, err := s.service.AddWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	last, err := s.service.AddWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	paths := map[string]string{"trailing separator": wanted.Path + string(filepath.Separator)}
	alias := filepath.Join(t.TempDir(), "workspace-alias")
	if err := os.Symlink(wanted.Path, alias); err == nil {
		paths["symlink alias"] = alias
	} else {
		t.Logf("Symlink alias unavailable: %v", err)
	}
	for name, path := range paths {
		t.Run(name, func(t *testing.T) {
			status, body, _ := featureRequest(t, s, http.MethodPost, "/api/workspaces", map[string]string{"path": path}, true)
			if status != http.StatusOK {
				t.Fatalf("add workspace: %d %s", status, body)
			}
			var response struct {
				OK        bool           `json:"ok"`
				Workspace desk.Workspace `json:"workspace"`
			}
			if err := json.Unmarshal([]byte(body), &response); err != nil {
				t.Fatal(err)
			}
			if !response.OK || response.Workspace != wanted || response.Workspace.ID == last.ID {
				t.Fatalf("response did not identify canonical requested workspace: %s", body)
			}
			if len(s.service.Snapshot().Workspaces) != 2 {
				t.Fatal("canonical alias added a duplicate workspace")
			}
			status, body, _ = featureRequest(t, s, http.MethodPost, "/api/conversations", map[string]string{"workspaceId": response.Workspace.ID}, true)
			if status != http.StatusOK {
				t.Fatalf("create conversation using returned ID: %d %s", status, body)
			}
			state := s.service.Snapshot()
			found := false
			for _, conversation := range state.Conversations {
				if conversation.ID == state.ActiveID {
					found = true
					if conversation.WorkspaceID != wanted.ID {
						t.Fatal("returned ID opened a conversation in the wrong workspace")
					}
				}
			}
			if !found {
				t.Fatal("returned ID did not create an active conversation")
			}
		})
	}
}
