package desk

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/minifish-org/pith-desk/internal/localstore"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
)

// DraftStore owns draft files and revision validation, without a Service or
// cached second copy of drafts. The caller serializes saves and catalog cleanup.
type DraftStore struct {
	dataDir string
	files   localstore.Store
}

func (store DraftStore) read(path string) (Draft, error) {
	var draft Draft
	if err := store.files.ReadJSON(path, &draft); err != nil {
		return Draft{}, err
	}
	return draft, nil
}
func (store DraftStore) save(path string, in Draft) (Draft, error) {
	if len(in.Text) > MaxDraftBytes || !utf8.ValidString(in.Text) || in.Revision <= 0 || in.Revision > 9007199254740991 {
		return Draft{}, errors.New("Draft must be valid text of 8 MiB or less with a valid revision")
	}
	images := make([]aitypes.ImageContent, len(in.Images))
	ids := make(map[string]bool, len(in.Images))
	for i, image := range in.Images {
		if image.ID == "" || len(image.ID) > 128 || ids[image.ID] || len(image.Name) > 1024 || !utf8.ValidString(image.Name) || image.Size <= 0 || image.Size > MaxImageUploadBytes {
			return Draft{}, errors.New("Draft image has invalid metadata")
		}
		ids[image.ID] = true
		images[i] = image.ImageContent
	}
	if _, err := validateImages(images, &aitypes.Model{Input: []aitypes.ModelInputModality{"text", "image"}}); err != nil {
		return Draft{}, err
	}
	previous, err := store.read(path)
	if err != nil {
		return Draft{}, err
	}
	// Unload saves can arrive before an older autosave. A cleared draft retains
	// its revision so an older request cannot bring submitted text back.
	if in.Revision <= previous.Revision {
		return previous, nil
	}
	if err := store.files.WriteJSON(path, in); err != nil {
		return Draft{}, err
	}
	return in, nil
}

func (store DraftStore) prune(valid map[string]bool) error {
	root, err := os.OpenRoot(store.dataDir)
	if err != nil {
		return err
	}
	defer root.Close()
	dir, err := root.Open("drafts")
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer dir.Close()
	entries, err := dir.ReadDir(-1)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".json") && !valid[entry.Name()] {
			if err := root.Remove(filepath.Join("drafts", entry.Name())); err != nil {
				return err
			}
		}
	}
	return nil
}
