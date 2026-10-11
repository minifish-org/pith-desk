package localstore_test

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/minifish-org/pith-desk/internal/localstore"
	"github.com/minifish-org/pith-desk/internal/testsupport/filefault"
)

func TestAtomicJSONFailuresPreserveCommittedFile(t *testing.T) {
	for _, stage := range []string{"mkdir", "create", "write", "sync", "close", "rename"} {
		t.Run(stage, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "settings.json")
			old := []byte("{\"appearance\":\"light\"}\n")
			if err := os.WriteFile(path, old, 0600); err != nil {
				t.Fatal(err)
			}
			fs := &filefault.FS{Step: stage}
			if err := (localstore.Store{FS: fs}).WriteJSON(path, map[string]string{"appearance": "dark"}); !errors.Is(err, filefault.ErrInjected) {
				t.Fatalf("failure not returned: %v", err)
			}
			actual, err := os.ReadFile(path)
			if err != nil || !bytes.Equal(actual, old) {
				t.Fatalf("old commit changed: %q, %v", actual, err)
			}
			entries, err := os.ReadDir(dir)
			if err != nil || len(entries) != 1 || entries[0].Name() != "settings.json" {
				t.Fatalf("temporary files leaked: %v, %v", entries, err)
			}
			if stage != "rename" && containsCall(fs.Calls, "rename") {
				t.Fatalf("renamed before successful sync/close: %v", fs.Calls)
			}
			// A failed attempt must not poison a subsequent ordinary save.
			if err := (localstore.Store{}).WriteJSON(path, map[string]string{"appearance": "dark"}); err != nil {
				t.Fatal(err)
			}
			var value map[string]string
			if err := (localstore.Store{}).ReadJSON(path, &value); err != nil || value["appearance"] != "dark" {
				t.Fatalf("retry: %v, %v", value, err)
			}
		})
	}
}

func containsCall(calls []string, wanted string) bool {
	for _, call := range calls {
		if call == wanted {
			return true
		}
	}
	return false
}

func TestAtomicJSONSuccessUsesPrivateFileAndOrderedCommit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "new", "catalog.json")
	fs := &filefault.FS{}
	if err := (localstore.Store{FS: fs}).WriteJSON(path, []string{"conversation"}); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(fs.Calls, []string{"create", "write", "sync", "close", "rename"}) {
		t.Fatalf("commit order: %v", fs.Calls)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("private file: %v, %v", info, err)
	}
	info, err = os.Stat(filepath.Dir(path))
	if err != nil || info.Mode().Perm() != 0700 {
		t.Fatalf("private directory: %v, %v", info, err)
	}
}

func TestAtomicJSONRejectsEncodingBeforeCreatingFiles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "catalog.json")
	fs := &filefault.FS{}
	if err := (localstore.Store{FS: fs}).WriteJSON(path, make(chan int)); err == nil {
		t.Fatal("encoding failure ignored")
	}
	if len(fs.Calls) != 0 {
		t.Fatalf("encoding failure touched filesystem: %v", fs.Calls)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("created authoritative file: %v", err)
	}
}
