package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/egoist/mygo"
	"github.com/minifish-org/pith-desk/internal/host"
)

func installWorkspaceFileDrop(win *mygo.Window, server *host.Server) {
	server.SetNativeFileDrop(true)
	win.OnFileDrop(func(event *mygo.FileDropEvent) {
		copy := *event
		copy.Paths = append([]string(nil), event.Paths...)
		go func() {
			if err := forwardNativeFileDrop(win, &copy); err != nil {
				log.Printf("Pith Desk file drop: %v", err)
			}
		}()
	})
}

func forwardNativeFileDrop(win *mygo.Window, event *mygo.FileDropEvent) error {
	script, err := nativeFileDropScript(event)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err = win.Page().EvalContext(ctx, script)
	return err
}

// The HTTP page is intentionally not trusted by MyGo's binding runtime. Forward
// only this native event, without exposing bound methods or relaxing navigation.
func nativeFileDropScript(event *mygo.FileDropEvent) (string, error) {
	data, err := json.Marshal(event)
	if err != nil {
		return "", err
	}
	return "window.dispatchEvent(new CustomEvent('pith:file-drop', {detail:" + string(data) + "}));", nil
}
