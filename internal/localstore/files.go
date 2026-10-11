package localstore

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
)

// A per-call filesystem seam makes commit failures deterministic without
// process-wide hooks. The OS implementation keeps the existing write protocol.
type File interface {
	io.Reader
	io.Writer
	Sync() error
	Close() error
	Name() string
}

type FileSystem interface {
	MkdirAll(string, os.FileMode) error
	CreateTemp(string, string) (File, error)
	Rename(string, string) error
	Remove(string) error
	ReadFile(string) ([]byte, error)
	OpenFile(string, int, os.FileMode) (File, error)
}

type OS struct{}

func (OS) MkdirAll(path string, mode os.FileMode) error { return os.MkdirAll(path, mode) }
func (OS) CreateTemp(dir, pattern string) (File, error) {
	return os.CreateTemp(dir, pattern)
}
func (OS) Rename(from, to string) error { return os.Rename(from, to) }
func (OS) Remove(path string) error     { return os.Remove(path) }

func (s Store) WriteJSON(path string, value any) error {
	fs := s.filesystem()
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	if err := fs.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	file, err := fs.CreateTemp(filepath.Dir(path), ".save-*")
	if err != nil {
		return err
	}
	defer fs.Remove(file.Name())
	if _, err := file.Write(append(data, '\n')); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return fs.Rename(file.Name(), path)
}

// Store owns file mechanics only. Owners supply paths and values and retain
// synchronization and business commit order. The zero value uses the OS.
// FS is instance-scoped; it supports deterministic fault tests without globals.
type Store struct{ FS FileSystem }

func (s Store) filesystem() FileSystem {
	if s.FS != nil {
		return s.FS
	}
	return OS{}
}
func (OS) ReadFile(path string) ([]byte, error) { return os.ReadFile(path) }
func (OS) OpenFile(path string, flags int, mode os.FileMode) (File, error) {
	return os.OpenFile(path, flags, mode)
}
func (s Store) ReadJSON(path string, target any) error {
	data, err := s.filesystem().ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	return json.Unmarshal(data, target)
}

// EnsureDirectory creates a private parent; existing permissions are preserved.
func (s Store) EnsureDirectory(path string) error { return s.filesystem().MkdirAll(path, 0700) }

// AppendJSONL requires an existing parent directory and is not a transaction.
// Partial writes can leave a corrupt tail;
// callers must report failure and keep the ledger unavailable until reviewed.
func (s Store) AppendJSONL(path string, value any) error {
	fs := s.filesystem()
	file, err := fs.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	err = json.NewEncoder(file).Encode(value)
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	return err
}

// ScanJSONL preserves streaming reads and propagates corrupt records. Missing
// ledgers are empty; this does not repair an incomplete tail as the SDK does.
func (s Store) ScanJSONL(path string, visit func(json.RawMessage) error) error {
	file, err := s.filesystem().OpenFile(path, os.O_RDONLY, 0)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	for {
		var value json.RawMessage
		if err := decoder.Decode(&value); errors.Is(err, io.EOF) {
			return nil
		} else if err != nil {
			return err
		}
		if err := visit(value); err != nil {
			return err
		}
	}
}
