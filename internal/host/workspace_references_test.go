package host

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestWorkspaceReferencesUseAuthenticatedValidatedPaths(t *testing.T) {
	s := testServer(t)
	workspace, err := s.service.AddWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(workspace.Path, "中文 file.txt")
	if err := os.WriteFile(path, []byte("not imported"), 0644); err != nil {
		t.Fatal(err)
	}
	in := map[string]any{"workspaceId": workspace.ID, "paths": []string{path}}
	if status, _, _ := featureRequest(t, s, "POST", "/api/workspace-references", in, false); status != http.StatusUnauthorized {
		t.Fatalf("unauthenticated reference request: %d", status)
	}
	status, body, _ := featureRequest(t, s, "POST", "/api/workspace-references", in, true)
	var response struct {
		Paths []string `json:"paths"`
	}
	if status != http.StatusOK || json.Unmarshal([]byte(body), &response) != nil || !reflect.DeepEqual(response.Paths, []string{"中文 file.txt"}) {
		t.Fatalf("reference response: %d %s", status, body)
	}
	in["paths"] = []string{"中文 file.txt"}
	if status, body, _ := featureRequest(t, s, "POST", "/api/workspace-references", in, true); status != http.StatusBadRequest {
		t.Fatalf("browser filename trusted: %d %s", status, body)
	}
	if status, _, _ := featureRequest(t, s, "POST", "/api/workspace-references", map[string]any{"workspaceId": workspace.ID, "paths": []string{path}, "import": true}, true); status != http.StatusBadRequest {
		t.Fatalf("unknown field accepted: %d", status)
	}
}
