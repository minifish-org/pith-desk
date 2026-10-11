package filefault

import (
	"errors"
	"os"

	"github.com/minifish-org/pith-desk/internal/localstore"
)

var ErrInjected = errors.New("injected storage failure")

type FS struct {
	localstore.OS
	Step  string
	Calls []string
}

func (f *FS) MkdirAll(path string, mode os.FileMode) error {
	if f.Step == "mkdir" {
		return ErrInjected
	}
	return f.OS.MkdirAll(path, mode)
}

func (f *FS) CreateTemp(dir, pattern string) (localstore.File, error) {
	f.Calls = append(f.Calls, "create")
	if f.Step == "create" {
		return nil, ErrInjected
	}
	opened, err := f.OS.CreateTemp(dir, pattern)
	if err != nil {
		return nil, err
	}
	return &file{File: opened, fs: f}, nil
}

func (f *FS) Rename(from, to string) error {
	f.Calls = append(f.Calls, "rename")
	if f.Step == "rename" {
		return ErrInjected
	}
	return f.OS.Rename(from, to)
}

type file struct {
	localstore.File
	fs *FS
}

func (f *file) Write(data []byte) (int, error) {
	f.fs.Calls = append(f.fs.Calls, "write")
	if f.fs.Step == "write" {
		n, _ := f.File.Write(data[:len(data)/2])
		return n, ErrInjected
	}
	return f.File.Write(data)
}
func (f *file) Sync() error {
	f.fs.Calls = append(f.fs.Calls, "sync")
	if f.fs.Step == "sync" {
		return ErrInjected
	}
	return f.File.Sync()
}
func (f *file) Close() error {
	f.fs.Calls = append(f.fs.Calls, "close")
	err := f.File.Close()
	if f.fs.Step == "close" {
		return ErrInjected
	}
	return err
}

func (f *FS) OpenFile(path string, flags int, mode os.FileMode) (localstore.File, error) {
	f.Calls = append(f.Calls, "open")
	if f.Step == "open" {
		return nil, ErrInjected
	}
	opened, err := f.OS.OpenFile(path, flags, mode)
	if err != nil {
		return nil, err
	}
	return &file{File: opened, fs: f}, nil
}
