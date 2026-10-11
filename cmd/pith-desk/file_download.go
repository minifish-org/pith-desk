package main

import (
	"io"
	"os"
	"path/filepath"
	"sync"

	"github.com/egoist/mygo"
	"github.com/minifish-org/pith-desk/internal/host"
)

func installFileDownload(server *host.Server, parent func() *mygo.Window, dialogMu *sync.Mutex) {
	server.SetFileDownloadAction(func(name string, source io.Reader) error {
		dialogMu.Lock()
		defer dialogMu.Unlock()
		downloads, err := mygo.App.Path(mygo.PathDownloads)
		if err != nil {
			return err
		}
		path, err := mygo.Dialog.Save(mygo.SaveDialogOptions{
			Parent: parent(), Title: "Save file",
			DefaultPath: filepath.Join(downloads, name), CreateDirectories: true,
		})
		if err != nil || path == "" {
			return err
		}
		return saveDownloadedFile(path, source)
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
