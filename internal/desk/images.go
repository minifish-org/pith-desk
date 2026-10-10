package desk

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	agenttypes "github.com/minifish-org/pith/packages/agent/types"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
)

// This bounds local upload memory, independently of any provider's image limits.
const MaxImageUploadBytes = 50 << 20

// MessageImage is a reference into Pith's transcript, never the image bytes.
// Large attachments do not get retransmitted with every streaming text update.
type MessageImage struct {
	Index    int    `json:"index"`
	MimeType string `json:"mimeType"`
}

func supportedImageType(mime string) bool {
	return mime == "image/png" || mime == "image/jpeg" || mime == "image/gif" || mime == "image/webp"
}

func validateImages(images []aitypes.ImageContent, model *aitypes.Model) ([]aitypes.ImageContent, error) {
	if len(images) == 0 {
		return nil, nil
	}
	if model == nil || !model.SupportsImageInput() {
		return nil, errors.New("This model does not support images. Choose an image-capable model in Settings, or remove the attachments")
	}
	out := append([]aitypes.ImageContent(nil), images...)
	total := 0
	for i, image := range out {
		if image.Type != aitypes.ContentTypeImage || !supportedImageType(image.MimeType) {
			return nil, errors.New("Use PNG, JPEG, GIF or WebP images")
		}
		if len(image.Data) > base64.StdEncoding.EncodedLen(MaxImageUploadBytes-total) {
			return nil, errors.New("Image attachments must total 50 MiB or less per message")
		}
		data, err := base64.StdEncoding.Strict().DecodeString(image.Data)
		if err != nil || len(data) == 0 || http.DetectContentType(data) != image.MimeType {
			return nil, fmt.Errorf("Image %d has invalid data or a mismatched file type", i+1)
		}
		total += len(data)
		if total > MaxImageUploadBytes {
			return nil, errors.New("Image attachments must total 50 MiB or less per message")
		}
	}
	return out, nil
}

func messageImages(blocks []aitypes.ContentBlock) []MessageImage {
	var out []MessageImage
	for _, block := range blocks {
		if block.Image != nil && supportedImageType(block.Image.MimeType) {
			out = append(out, MessageImage{Index: len(out), MimeType: block.Image.MimeType})
		}
	}
	return out
}

// ConversationImage reads only an existing image block in a known transcript.
// The HTTP layer applies the same host, origin and bearer-token checks as send.
func (s *Service) ConversationImage(id, messageID string, index int) ([]byte, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || index < 0 || s.conversationIndexLocked(id) < 0 {
		return nil, "", errors.New("Image attachment not found")
	}
	manager := s.active.activeManager
	if id != s.state.ActiveID || manager == nil {
		var err error
		manager, err = s.readConversationSessionLocked(id)
		if err != nil {
			return nil, "", err
		}
		if manager != nil {
			defer manager.Close()
		}
	}
	if manager != nil {
		for _, entry := range manager.Context() {
			if entry.ID != messageID || entry.Type != "message" {
				continue
			}
			var message agenttypes.AgentMessage
			if json.Unmarshal(entry.Payload, &message) != nil || message.Message == nil {
				break
			}
			var blocks []aitypes.ContentBlock
			if message.Message.User != nil {
				blocks = message.Message.User.Content.Blocks
			}
			if message.Message.ToolResult != nil {
				blocks = message.Message.ToolResult.Content
			}
			current := 0
			for _, block := range blocks {
				if block.Image == nil || !supportedImageType(block.Image.MimeType) {
					continue
				}
				if current == index {
					data, err := base64.StdEncoding.Strict().DecodeString(block.Image.Data)
					if err != nil || http.DetectContentType(data) != block.Image.MimeType {
						break
					}
					return data, block.Image.MimeType, nil
				}
				current++
			}
		}
	}
	return nil, "", errors.New("Image attachment not found")
}
