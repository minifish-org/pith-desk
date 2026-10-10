package desk

import (
	"bufio"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unicode/utf8"
)

const maxTextPreviewBytes = 256 << 10
const maxImagePreviewBytes = 8 << 20

type ArtifactPreview struct {
	Kind      string `json:"kind"`
	Text      string `json:"text,omitempty"`
	Data      string `json:"data,omitempty"`
	MimeType  string `json:"mimeType,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
}

// Open via the workspace root at read time, including after artifact discovery.
func (p *filePolicy) openRegular(path string) (io.ReadCloser, error) {
	rel, err := p.checked(path)
	if err != nil {
		return nil, err
	}
	info, err := p.root.Stat(rel)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("Preview a regular file inside the workspace")
	}
	// Nonblocking open also handles a regular file being replaced by a pipe
	// between validation and opening it.
	file, err := p.root.OpenFile(rel, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	info, err = file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		file.Close()
		return nil, errors.New("Preview a regular file inside the workspace")
	}
	return file, nil
}

func (s *Service) PreviewArtifact(id, path string) (ArtifactPreview, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.conversationIdleLocked(id); err != nil {
		return ArtifactPreview{}, err
	}
	artifacts, err := s.artifactsLocked(id)
	if err != nil {
		return ArtifactPreview{}, err
	}
	found := false
	for _, artifact := range artifacts {
		if artifact.Path == path {
			found = true
			break
		}
	}
	if !found {
		return ArtifactPreview{}, errors.New("Preview a file produced by this conversation inside its workspace")
	}
	index := s.conversationIndexLocked(id)
	workspace, _ := s.workspaceLocked(s.state.Conversations[index].WorkspaceID)
	policy, err := newFilePolicy(workspace.Path, s.dataDir)
	if err != nil {
		return ArtifactPreview{}, err
	}
	defer policy.root.Close()
	file, err := policy.openRegular(path)
	if err != nil {
		return ArtifactPreview{}, err
	}
	defer file.Close()
	reader := bufio.NewReader(file)
	header, peekErr := reader.Peek(512)
	if peekErr != nil && peekErr != io.EOF {
		return ArtifactPreview{}, peekErr
	}
	mime := http.DetectContentType(header)
	limit := maxTextPreviewBytes
	if supportedImageType(mime) {
		limit = maxImagePreviewBytes
	}
	data, err := io.ReadAll(io.LimitReader(reader, int64(limit+1)))
	if err != nil {
		return ArtifactPreview{}, err
	}
	truncated := len(data) > limit
	if supportedImageType(mime) {
		if truncated {
			return ArtifactPreview{}, errors.New("This image is too large to preview (8 MiB limit). Use Open to view it")
		}
		return ArtifactPreview{Kind: "image", MimeType: mime, Data: base64.StdEncoding.EncodeToString(data)}, nil
	}
	if truncated {
		data = data[:limit]
		// Do not cut a UTF-8 character at the preview boundary.
		for len(data) > 0 && !utf8.Valid(data) && len(data) > limit-4 {
			data = data[:len(data)-1]
		}
	}
	if !utf8.Valid(data) || strings.ContainsRune(string(data), 0) {
		return ArtifactPreview{}, errors.New("This file has no text or image preview. Use Open to view it")
	}
	kind := "text"
	ext := strings.ToLower(filepath.Ext(path))
	if ext == ".md" || ext == ".markdown" {
		kind = "markdown"
	}
	return ArtifactPreview{Kind: kind, Text: strings.TrimPrefix(string(data), "\ufeff"), Truncated: truncated}, nil
}
