package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/egoist/mygo"
	"github.com/minifish-org/pith-desk/internal/host"
)

// A page cannot read the bytes of a local file it only knows the path of, so a
// dropped image travels through the native bridge. The page's own drop handler
// keeps serving browsers, which get real File objects.
const (
	droppedImageLimit  = 8 << 20
	droppedImagesTotal = 16 << 20
)

var droppedImageTypes = map[string]bool{
	"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true,
}
var droppedImageExtensions = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true,
}

// nativeDropPayload is what the page receives: the paths of the drop, plus the
// images among them. Paths stay as dropped; the page filters images out of its
// workspace references.
type nativeDropPayload struct {
	Paths  []string       `json:"paths"`
	X      int            `json:"x"`
	Y      int            `json:"y"`
	Images []droppedImage `json:"images"`
	Notice string         `json:"notice"`
}

type droppedImage struct {
	Name     string `json:"name"`
	MimeType string `json:"mimeType"`
	Data     string `json:"data"`
}

func installWorkspaceFileDrop(win *desktopWindow, server *host.Server) {
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

func forwardNativeFileDrop(win *desktopWindow, event *mygo.FileDropEvent) error {
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
	data, err := json.Marshal(nativeDropPayloadFor(event))
	if err != nil {
		return "", err
	}
	return "window.dispatchEvent(new CustomEvent('pith:file-drop', {detail:" + string(data) + "}));", nil
}

func nativeDropPayloadFor(event *mygo.FileDropEvent) nativeDropPayload {
	images, notices := readDroppedImages(event.Paths)
	return nativeDropPayload{Paths: event.Paths, X: event.X, Y: event.Y, Images: images, Notice: strings.Join(notices, " ")}
}

// Unreadable or unsupported images are reported instead of disappearing from a
// drop that silently did nothing.
func readDroppedImages(paths []string) ([]droppedImage, []string) {
	var images []droppedImage
	var notices []string
	total := 0
	for _, path := range paths {
		if !droppedImageExtensions[strings.ToLower(filepath.Ext(path))] {
			continue
		}
		name := filepath.Base(path)
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
			notices = append(notices, name+" is not a readable image file.")
			continue
		}
		if info.Size() > droppedImageLimit {
			notices = append(notices, fmt.Sprintf("%s is too large to drop (%d MiB limit). Use Attach images.", name, droppedImageLimit>>20))
			continue
		}
		data, err := os.ReadFile(path)
		if err != nil {
			notices = append(notices, name+" is not a readable image file.")
			continue
		}
		if len(data) > droppedImageLimit || total+len(data) > droppedImagesTotal {
			notices = append(notices, fmt.Sprintf("Dropped images are limited to %d MiB each and %d MiB in total. Use Attach images.", droppedImageLimit>>20, droppedImagesTotal>>20))
			continue
		}
		mimeType := http.DetectContentType(data)
		if !droppedImageTypes[mimeType] {
			notices = append(notices, name+" is not a PNG, JPEG, GIF or WebP image.")
			continue
		}
		total += len(data)
		images = append(images, droppedImage{Name: name, MimeType: mimeType, Data: base64.StdEncoding.EncodeToString(data)})
	}
	return images, notices
}
