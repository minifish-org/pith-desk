package desk

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestResourceInventoryUsesPithDiscoveryAndGuardedOpening(t *testing.T) {
	s, workspace, _, _ := productFeatureService(t)
	inherited := filepath.Join(filepath.Dir(workspace.Path), "AGENTS.md")
	if err := os.WriteFile(inherited, []byte("Inherited project guidance."), 0644); err != nil {
		t.Fatal(err)
	}
	skillPath := filepath.Join(workspace.Path, ".pi", "skills", "writer", "SKILL.md")
	if err := os.MkdirAll(filepath.Dir(skillPath), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(skillPath, []byte("---\nname: writer\ndescription: Draft concise documents\n---\nSkill body must not be in the inventory.\n"), 0644); err != nil {
		t.Fatal(err)
	}
	inventory, err := s.Resources(workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(inventory.Instructions) != 1 || inventory.Instructions[0].Content != "Inherited project guidance." {
		t.Fatalf("instruction discovery: %+v", inventory)
	}
	if len(inventory.Skills) != 1 || inventory.Skills[0].Name != "writer" {
		t.Fatalf("skill discovery: %+v", inventory)
	}
	encoded, _ := json.Marshal(inventory)
	if strings.Contains(string(encoded), "Skill body must") {
		t.Fatal("skill body leaked into metadata inventory")
	}
	if path, err := s.ResolveResourceFile(workspace.ID, inherited); err != nil || path != inherited {
		t.Fatalf("inherited instruction open: %q %v", path, err)
	}
	if _, err := s.ResolveResourceFile(workspace.ID, skillPath); err != nil {
		t.Fatal(err)
	}
	unrelated := filepath.Join(workspace.Path, "unrelated.txt")
	if err := os.WriteFile(unrelated, []byte("Not a resource"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ResolveResourceFile(workspace.ID, unrelated); err == nil {
		t.Fatal("arbitrary file was allowed through resource open")
	}
	created, err := s.CreateInstructions(workspace.ID)
	if err != nil || created != filepath.Join(workspace.Path, "AGENTS.md") {
		t.Fatalf("create instructions: %q %v", created, err)
	}
	before, _ := os.ReadFile(created)
	if _, err := s.CreateInstructions(workspace.ID); err == nil {
		t.Fatal("existing instructions were overwritten")
	}
	after, _ := os.ReadFile(created)
	if string(before) != string(after) {
		t.Fatal("existing instruction content changed")
	}
}

func TestResourceDiscoveryRejectsPrivateAndExternalSkillSymlinksBeforeRead(t *testing.T) {
	for _, kind := range []string{"instruction", "skills", "prompts", "append-system", "external-skill"} {
		t.Run(kind, func(t *testing.T) {
			s, workspace, _, dataDir := productFeatureService(t)
			privateFile := filepath.Join(dataDir, "secret.md")
			if err := os.WriteFile(privateFile, []byte("PRIVATE CONTENT"), 0600); err != nil {
				t.Fatal(err)
			}
			var source, destination string
			switch kind {
			case "instruction":
				source, destination = privateFile, filepath.Join(workspace.Path, "AGENTS.md")
			case "append-system":
				source, destination = privateFile, filepath.Join(workspace.Path, ".pi", "APPEND_SYSTEM.md")
			default:
				source = dataDir
				folder := kind
				if kind == "external-skill" {
					source, folder = t.TempDir(), "skills"
				}
				destination = filepath.Join(workspace.Path, ".pi", folder)
			}
			if err := os.MkdirAll(filepath.Dir(destination), 0755); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(source, destination); err != nil {
				t.Skipf("symlinks unavailable: %v", err)
			}
			if err := validateRuntimeResources(workspace.Path, dataDir); err == nil {
				t.Fatal("unsafe discovery input accepted")
			}
			if inventory, err := s.Resources(workspace.ID); err == nil {
				t.Fatalf("unsafe inventory returned: %+v", inventory)
			}
			if _, err := s.ResolveResourceFile(workspace.ID, privateFile); err == nil {
				t.Fatal("private file was opened")
			}
		})
	}
}

func TestResourceDiscoveryRejectsExternalInstructionAndSystemSymlinksBeforeModelRequest(t *testing.T) {
	for _, kind := range []string{"project-instruction", "inherited-instruction", "system", "append-system", "config-directory"} {
		t.Run(kind, func(t *testing.T) {
			s, workspace, _, dataDir := productFeatureService(t)
			external := t.TempDir()
			secret := filepath.Join(external, "APPEND_SYSTEM.md")
			if err := os.WriteFile(secret, []byte("UNRELATED OUTSIDE CONTENT"), 0600); err != nil {
				t.Fatal(err)
			}
			source := secret
			var destination string
			switch kind {
			case "project-instruction":
				destination = filepath.Join(workspace.Path, "AGENTS.md")
			case "inherited-instruction":
				destination = filepath.Join(filepath.Dir(workspace.Path), "CLAUDE.md")
			case "system":
				destination = filepath.Join(workspace.Path, ".pi", "SYSTEM.md")
			case "append-system":
				destination = filepath.Join(workspace.Path, ".pi", "APPEND_SYSTEM.md")
			case "config-directory":
				source, destination = external, filepath.Join(workspace.Path, ".pi")
			}
			if err := os.MkdirAll(filepath.Dir(destination), 0755); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(source, destination); err != nil {
				t.Skipf("symlinks unavailable: %v", err)
			}
			if err := validateRuntimeResources(workspace.Path, dataDir); err == nil {
				t.Fatal("outside instruction indirection accepted")
			}
			if inventory, err := s.Resources(workspace.ID); err == nil {
				t.Fatalf("outside content loaded into inventory: %+v", inventory)
			}
			if _, err := s.ResolveResourceFile(workspace.ID, destination); err == nil {
				t.Fatal("outside instruction permitted for native opening")
			}

			var requests atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				requests.Add(1)
				w.WriteHeader(http.StatusBadRequest)
			}))
			defer provider.Close()
			if err := s.Configure(ConfigInput{BaseURL: provider.URL + "/v1", Model: "deepseek-flash", APIKey: "offline-placeholder"}); err != nil {
				t.Fatal(err)
			}
			if err := s.Send("Check the workspace"); err != nil {
				t.Fatal(err)
			}
			state := waitState(t, s, func(state State) bool { return !state.Running })
			if state.Error == "" || requests.Load() != 0 {
				t.Fatalf("unsafe resources reached the provider: error=%q requests=%d", state.Error, requests.Load())
			}
		})
	}
}

func TestResourceDiscoveryAllowsInstructionSymlinksInsideWorkspace(t *testing.T) {
	for _, inherited := range []bool{false, true} {
		t.Run(map[bool]string{false: "project", true: "inherited"}[inherited], func(t *testing.T) {
			s, workspace, _, dataDir := productFeatureService(t)
			source := filepath.Join(workspace.Path, "instructions.md")
			if err := os.WriteFile(source, []byte("Workspace-owned instructions."), 0644); err != nil {
				t.Fatal(err)
			}
			destination := filepath.Join(workspace.Path, "AGENTS.md")
			if inherited {
				destination = filepath.Join(filepath.Dir(workspace.Path), "CLAUDE.md")
			}
			if err := os.Symlink(source, destination); err != nil {
				t.Skipf("symlinks unavailable: %v", err)
			}
			for _, name := range []string{"SYSTEM.md", "APPEND_SYSTEM.md"} {
				path := filepath.Join(workspace.Path, ".pi", name)
				if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(source, path); err != nil {
					t.Skipf("symlinks unavailable: %v", err)
				}
			}
			if err := validateRuntimeResources(workspace.Path, dataDir); err != nil {
				t.Fatal(err)
			}
			inventory, err := s.Resources(workspace.ID)
			if err != nil || len(inventory.Instructions) != 1 || inventory.Instructions[0].Content != "Workspace-owned instructions." {
				t.Fatalf("workspace-owned symlink not discovered: %+v %v", inventory, err)
			}
			if path, err := s.ResolveResourceFile(workspace.ID, destination); err != nil || path != source {
				t.Fatalf("workspace-owned symlink not openable: %q %v", path, err)
			}
		})
	}
}
