package main

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/egoist/mygo"
	"github.com/minifish-org/pith-desk/internal/host"
)

func installFileSaves(server *host.Server, parent func() *mygo.Window, dialogMu *sync.Mutex, choosePath func(mygo.SaveDialogOptions) (string, error)) {
	save := func(options mygo.SaveDialogOptions, source io.Reader) error {
		dialogMu.Lock()
		defer dialogMu.Unlock()
		options.Parent, options.CreateDirectories = parent(), true
		path, err := choosePath(options)
		if err != nil || path == "" {
			return err // Cancel does not fall back to a browser download.
		}
		return saveDownloadedFile(path, source)
	}
	server.SetFileDownloadAction(func(name string, source io.Reader) error {
		downloads, err := mygo.App.Path(mygo.PathDownloads)
		if err != nil {
			return err
		}
		return save(mygo.SaveDialogOptions{Title: "Save file", DefaultPath: filepath.Join(downloads, name)}, source)
	})
	server.SetExportAction(func(markdown string) error {
		downloads, err := mygo.App.Path(mygo.PathDownloads)
		if err != nil {
			return err
		}
		return save(mygo.SaveDialogOptions{
			Title: "Export conversation", DefaultPath: filepath.Join(downloads, "conversation.md"),
			Filters: []mygo.FileFilter{{Name: "Markdown", Extensions: []string{"md"}}},
		}, strings.NewReader(markdown))
	})
	server.SetDiagnosticsAction(func(data string) error {
		return save(mygo.SaveDialogOptions{
			Title: "Save diagnostics", DefaultPath: "pith-desk-diagnostics.json",
			Filters: []mygo.FileFilter{{Name: "JSON", Extensions: []string{"json"}}},
		}, strings.NewReader(data))
	})
}

func saveDownloadedFile(path string, source io.Reader) error {
	// Write beside the chosen destination before replacing it. This also permits
	// saving over the source without truncating the still-open source handle.
	temp, err := os.CreateTemp(filepath.Dir(path), ".pith-desk-download-*")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	defer temp.Close()
	if _, err := io.Copy(temp, source); err != nil {
		return err
	}
	if err := temp.Sync(); err != nil {
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(temp.Name(), path)
}
