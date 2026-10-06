package host

import (
	"encoding/json"
	"errors"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
	"net/http"
	"strconv"
	"strings"

	"github.com/minifish-org/pith-desk/internal/desk"
)

// SetFileActions connects verified local paths to the native shell. Browser
// previews keep these callbacks unset; the HTTP host never executes commands.
func (s *Server) SetFileActions(open, reveal func(string) error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.openFile, s.revealFile = open, reveal
}

// SetExportAction lets the desktop choose a destination with its native save
// dialog. Browser preview leaves this unset and uses the authenticated download.
func (s *Server) SetExportAction(save func(string) error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.exportMarkdown = save
}

func (s *Server) SetDiagnosticsAction(save func(string) error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.saveDiagnostics = save
}

// These handlers run only after the common host, origin and token checks.
func (s *Server) serveFeatureRead(w http.ResponseWriter, r *http.Request) bool {
	if r.Method != http.MethodGet {
		return false
	}
	var value any
	var err error
	switch r.URL.Path {
	case "/api/image":
		index, parseErr := strconv.Atoi(r.URL.Query().Get("index"))
		if parseErr != nil {
			s.fail(w, "Image attachment not found", http.StatusNotFound)
			return true
		}
		data, mime, imageErr := s.service.ConversationImage(r.URL.Query().Get("id"), r.URL.Query().Get("message"), index)
		if imageErr != nil {
			s.fail(w, "Image attachment not found", http.StatusNotFound)
			return true
		}
		w.Header().Set("Content-Type", mime)
		_, _ = w.Write(data)
		return true
	case "/api/history":
		value, err = s.service.History(r.URL.Query().Get("id"))
	case "/api/costs":
		value, err = s.service.Costs(r.URL.Query().Get("id"))
	case "/api/resource-content":
		value, err = s.service.ResourceContent(r.URL.Query().Get("workspaceId"), r.URL.Query().Get("path"))
	case "/api/custom-connection":
		value, err = s.service.CustomConnection(r.URL.Query().Get("id"))
	case "/api/models":
		value, err = s.service.Models(r.URL.Query().Get("provider"))
	case "/api/resources":
		value, err = s.service.Resources(r.URL.Query().Get("workspaceId"))
	case "/api/artifacts":
		value, err = s.service.Artifacts(r.URL.Query().Get("id"))
	case "/api/mcp":
		value = s.service.ListMCP()
	case "/api/diagnostics":
		var data string
		data, err = s.service.Diagnostics()
		if err == nil {
			w.Header().Set("Content-Disposition", `attachment; filename="pith-desk-diagnostics.json"`)
			_, _ = w.Write([]byte(data))
			return true
		}
	case "/api/export":
		var markdown string
		markdown, err = s.service.ExportConversation(r.URL.Query().Get("id"))
		if err == nil {
			w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
			w.Header().Set("Content-Disposition", `attachment; filename="conversation.md"`)
			_, _ = w.Write([]byte(markdown))
			return true
		}
	default:
		return false
	}
	if err != nil {
		s.fail(w, err.Error(), http.StatusBadRequest)
	} else {
		_ = json.NewEncoder(w).Encode(value)
	}
	return true
}

func (s *Server) serveFeatureMutation(w http.ResponseWriter, r *http.Request, decode func(any) error) bool {
	var err error
	switch r.URL.Path {
	case "/api/custom-connection":
		var in desk.CustomConnectionInput
		if err = decode(&in); err == nil {
			err = s.service.SaveCustomConnection(in)
		}
	case "/api/remove-model-connection":
		var in struct {
			ID string `json:"id"`
		}
		if err = decode(&in); err == nil {
			err = s.service.RemoveModelConnection(in.ID)
		}
	case "/api/resource":
		var in desk.ResourceInput
		if err = decode(&in); err == nil {
			err = s.service.SaveResource(in)
		}
	case "/api/branch":
		var in struct {
			ID     string `json:"id"`
			NodeID string `json:"nodeId"`
			Before bool   `json:"before"`
		}
		if err = decode(&in); err == nil {
			err = s.service.BranchConversation(in.ID, in.NodeID, in.Before)
		}
	case "/api/compact":
		var in struct {
			ID string `json:"id"`
		}
		if err = decode(&in); err == nil {
			err = s.service.CompactConversation(in.ID)
		}
	case "/api/oauth/start":
		var in struct {
			Provider string `json:"provider"`
		}
		if err = decode(&in); err == nil {
			err = s.service.StartOAuth(in.Provider)
		}
	case "/api/oauth/answer":
		var in struct {
			ID     string `json:"id"`
			Answer string `json:"answer"`
		}
		if err = decode(&in); err == nil {
			err = s.service.AnswerOAuth(in.ID, in.Answer)
		}
	case "/api/oauth/cancel":
		s.service.CancelOAuth()
	case "/api/oauth/logout":
		var in struct {
			Provider string `json:"provider"`
		}
		if err = decode(&in); err == nil {
			err = s.service.LogoutOAuth(in.Provider)
		}
	case "/api/provider-config":
		var in desk.ProviderConnectionInput
		if err = decode(&in); err == nil {
			err = s.service.ConfigureProvider(in)
		}
	case "/api/test-provider-connection":
		var in desk.ProviderConnectionInput
		if err = decode(&in); err == nil {
			var result desk.ConnectionTest
			result, err = s.service.TestProviderConnection(r.Context(), in)
			if err == nil {
				_ = json.NewEncoder(w).Encode(result)
				return true
			}
		}
	case "/api/model-selection":
		var in struct {
			Provider      string `json:"provider"`
			Model         string `json:"model"`
			ThinkingLevel string `json:"thinkingLevel"`
		}
		if err = decode(&in); err == nil {
			err = s.service.SelectModel(in.Provider, in.Model, in.ThinkingLevel)
		}
	case "/api/test-connection":
		var in desk.ConfigInput
		if err = decode(&in); err == nil {
			var result desk.ConnectionTest
			result, err = s.service.TestConnection(r.Context(), in)
			if err == nil {
				_ = json.NewEncoder(w).Encode(result)
				return true
			}
		}
	case "/api/continue":
		var in struct {
			ID string `json:"id"`
		}
		if err = decode(&in); err == nil {
			err = s.service.ContinueTask(in.ID)
		}
	case "/api/diagnostics":
		var data string
		data, err = s.service.Diagnostics()
		if err == nil {
			s.mu.Lock()
			save := s.saveDiagnostics
			s.mu.Unlock()
			if save != nil {
				err = save(data)
			}
			if err == nil {
				_ = json.NewEncoder(w).Encode(map[string]bool{"native": save != nil})
				return true
			}
		}
	case "/api/export":
		var in struct {
			ID string `json:"id"`
		}
		if err = decode(&in); err == nil {
			var markdown string
			markdown, err = s.service.ExportConversation(in.ID)
			if err == nil {
				s.mu.Lock()
				save := s.exportMarkdown
				s.mu.Unlock()
				if save != nil {
					err = save(markdown)
				}
				if err == nil {
					_ = json.NewEncoder(w).Encode(map[string]bool{"native": save != nil})
					return true
				}
			}
		}
	case "/api/queue":
		var in struct {
			ID     string                 `json:"id"`
			Text   string                 `json:"text"`
			Mode   string                 `json:"mode"`
			Images []aitypes.ImageContent `json:"images"`
		}
		if err = decode(&in); err == nil {
			err = s.service.QueueMessage(in.ID, in.Text, in.Mode, in.Images...)
		}
	case "/api/queue/edit", "/api/queue/delete", "/api/queue/steer":
		var in struct {
			ID        string `json:"id"`
			MessageID string `json:"messageId"`
			Text      string `json:"text"`
		}
		if err = decode(&in); err == nil {
			err = s.service.MutateQueuedMessage(in.ID, in.MessageID, strings.TrimPrefix(r.URL.Path, "/api/queue/"), in.Text)
		}
	case "/api/rename":
		var in struct {
			ID    string `json:"id"`
			Title string `json:"title"`
		}
		if err = decode(&in); err == nil {
			err = s.service.RenameConversation(in.ID, in.Title)
		}
	case "/api/delete-conversation":
		var in struct {
			ID string `json:"id"`
		}
		if err = decode(&in); err == nil {
			err = s.service.DeleteConversation(in.ID)
		}
	case "/api/remove-workspace":
		var in struct {
			ID                string `json:"id"`
			ConversationCount *int   `json:"conversationCount"`
		}
		if err = decode(&in); err == nil {
			if in.ConversationCount == nil {
				err = errors.New("Review the workspace's conversation count before removing it")
			} else {
				err = s.service.RemoveWorkspace(in.ID, *in.ConversationCount)
			}
		}
	case "/api/create-instructions":
		var in struct {
			WorkspaceID string `json:"workspaceId"`
		}
		if err = decode(&in); err == nil {
			var path string
			path, err = s.service.CreateInstructions(in.WorkspaceID)
			if err == nil {
				_ = json.NewEncoder(w).Encode(map[string]string{"path": path})
				return true
			}
		}
	case "/api/file":
		var in struct {
			Kind        string `json:"kind"`
			ID          string `json:"id,omitempty"`
			WorkspaceID string `json:"workspaceId,omitempty"`
			Path        string `json:"path"`
			Action      string `json:"action"`
		}
		if err = decode(&in); err == nil {
			var path string
			switch in.Kind {
			case "artifact":
				path, err = s.service.ResolveArtifactFile(in.ID, in.Path)
			case "resource":
				path, err = s.service.ResolveResourceFile(in.WorkspaceID, in.Path)
			default:
				err = errors.New("Choose a generated file or a discovered workspace resource")
			}
			if err == nil {
				s.mu.Lock()
				open, reveal := s.openFile, s.revealFile
				s.mu.Unlock()
				switch in.Action {
				case "open":
					if open == nil {
						err = errors.New("Open files in the desktop app; use the displayed path in browser preview")
					} else {
						err = open(path)
					}
				case "reveal":
					if reveal == nil {
						err = errors.New("Reveal files in the desktop app; use the displayed path in browser preview")
					} else {
						err = reveal(path)
					}
				default:
					err = errors.New("Choose open or reveal")
				}
			}
		}
	case "/api/mcp/oauth/start", "/api/mcp/oauth/logout":
		var in struct {
			Name string `json:"name"`
		}
		if err = decode(&in); err == nil {
			if r.URL.Path == "/api/mcp/oauth/start" {
				err = s.service.StartMCPOAuth(in.Name)
			} else {
				err = s.service.LogoutMCPOAuth(in.Name)
			}
		}
	case "/api/mcp/save":
		var in desk.MCPInput
		if err = decode(&in); err == nil {
			err = s.service.SaveMCP(in)
		}
	case "/api/mcp/remove":
		var in struct {
			Name string `json:"name"`
		}
		if err = decode(&in); err == nil {
			err = s.service.RemoveMCP(in.Name)
		}
	case "/api/mcp/connect":
		err = s.service.ConnectMCP(r.Context())
	case "/api/mcp/disconnect":
		err = s.service.DisconnectMCP()
	default:
		return false
	}
	if err != nil {
		s.fail(w, err.Error(), http.StatusBadRequest)
	} else {
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	}
	return true
}
