//go:build darwin || linux

package desk

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestResourceCreationWriteFailureLeavesNoFileAndCanRetry(t *testing.T) {
	// A process-wide file limit must never affect other tests or application data.
	if os.Getenv("PITH_DESK_RESOURCE_WRITE_FAILURE") != "1" {
		executable, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, executable, "-test.run=^TestResourceCreationWriteFailureLeavesNoFileAndCanRetry$", "-test.v")
		command.Env = append(os.Environ(), "PITH_DESK_RESOURCE_WRITE_FAILURE=1")
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("resource write-failure subprocess: %v\n%s", err, output)
		}
		t.Logf("%s", output)
		return
	}
	signal.Ignore(syscall.SIGXFSZ)
	for _, kind := range []string{"instructions", "skill", "template", "default-instructions"} {
		t.Run(kind, func(t *testing.T) {
			s, workspace, _, _ := productFeatureService(t)
			input := ResourceInput{WorkspaceID: workspace.ID, Kind: kind, Name: "writer", Content: "---\nname: writer\ndescription: Write notes\n---\n\n" + strings.Repeat("Complete instructions.\n", 128)}
			path := filepath.Join(workspace.Path, "AGENTS.md")
			if kind == "skill" {
				path = filepath.Join(workspace.Path, ".pi", "skills", input.Name, "SKILL.md")
			} else if kind == "template" {
				path = filepath.Join(workspace.Path, ".pi", "prompts", input.Name+".md")
			}
			create := func() error {
				if kind == "default-instructions" {
					created, err := s.CreateInstructions(workspace.ID)
					if err == nil && created != path {
						t.Fatalf("created path %q, want %q", created, path)
					}
					return err
				}
				return s.SaveResource(input)
			}
			limitedWrite := func(write func() error) error {
				var previous syscall.Rlimit
				if err := syscall.Getrlimit(syscall.RLIMIT_FSIZE, &previous); err != nil {
					t.Fatal(err)
				}
				limit := previous
				limit.Cur = 32
				if err := syscall.Setrlimit(syscall.RLIMIT_FSIZE, &limit); err != nil {
					t.Fatal(err)
				}
				err := write()
				if restoreErr := syscall.Setrlimit(syscall.RLIMIT_FSIZE, &previous); restoreErr != nil {
					t.Fatal(restoreErr)
				}
				return err
			}
			if err := limitedWrite(create); !errors.Is(err, syscall.EFBIG) {
				t.Fatalf("expected an actual file write failure, got %v", err)
			}
			if data, err := os.ReadFile(path); !os.IsNotExist(err) {
				t.Fatalf("failed creation left %d bytes at %s: %v", len(data), path, err)
			}
			if err := create(); err != nil {
				t.Fatalf("retry after restoring write capacity: %v", err)
			}
			original, err := os.ReadFile(path)
			if err != nil || len(original) <= 32 || kind != "default-instructions" && string(original) != input.Content {
				t.Fatalf("retry did not save the complete resource: %d bytes, %v", len(original), err)
			}
			if err := create(); err == nil {
				t.Fatal("creation overwrote an existing resource")
			}
			edit := ResourceInput{WorkspaceID: workspace.ID, Path: path, Content: strings.Repeat("Replacement instructions.\n", 128)}
			if err := limitedWrite(func() error { return s.SaveResource(edit) }); !errors.Is(err, syscall.EFBIG) {
				t.Fatalf("expected an actual edit write failure, got %v", err)
			}
			if data, err := os.ReadFile(path); err != nil || string(data) != string(original) {
				t.Fatalf("failed edit changed the original resource: %v", err)
			}
			leftovers, err := filepath.Glob(filepath.Join(filepath.Dir(path), ".desk-resource-*"))
			if err != nil || len(leftovers) != 0 {
				t.Fatalf("failed edit left temporary resources: %v, %v", leftovers, err)
			}
		})
	}
}
