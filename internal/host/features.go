package host

import (
	"errors"
	"net/http"
	"strings"

	"github.com/minifish-org/pith-desk/internal/desk"
	"github.com/minifish-org/pith-desk/internal/wire"
)

// SetFileActions connects verified local paths to the native shell. Browser
// previews keep these callbacks unset; the HTTP host never executes commands.
func (s *Server) SetFileActions(open, reveal func(string) error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.openFile, s.revealFile = open, reveal
}

// SetClipboardActions connects explicit copy actions to the system clipboard.
// File copies use the same recorded-artifact validation as Open and Reveal.
func (s *Server) SetClipboardActions(text, file func(string) error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.copyText, s.copyFile = text, file
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
		query, queryErr := wire.ReadQuery[wire.ImageQuery](r)
		if queryErr != nil {
			s.fail(w, "Image attachment not found", http.StatusNotFound)
			return true
		}
		data, mime, imageErr := s.service.ConversationImage(query.ID, query.Message, query.Index)
		if imageErr != nil {
			s.fail(w, "Image attachment not found", http.StatusNotFound)
			return true
		}
		w.Header().Set("Content-Type", mime)
		_, _ = w.Write(data)
		return true
	case "/api/history":
		query, queryErr := wire.ReadQuery[wire.IDInput](r)
		if queryErr != nil {
			err = queryErr
			break
		}
		value, err = s.service.History(query.ID)
	case "/api/costs":
		query, queryErr := wire.ReadQuery[wire.IDInput](r)
		if queryErr != nil {
			err = queryErr
			break
		}
		value, err = s.service.Costs(query.ID)
	case "/api/resource-content":
		query, queryErr := wire.ReadQuery[wire.ResourceQuery](r)
		if queryErr != nil {
			err = queryErr
			break
		}
		var content map[string]string
		content, err = s.service.ResourceContent(query.WorkspaceID, query.Path)
		value = wire.ResourceContentResponse{Content: content["content"]}
	case "/api/custom-connection":
		query, queryErr := wire.ReadQuery[wire.IDInput](r)
		if queryErr != nil {
			err = queryErr
			break
		}
		value, err = s.service.CustomConnection(query.ID)
	case "/api/models":
		query, queryErr := wire.ReadQuery[wire.ModelsQuery](r)
		if queryErr != nil {
			err = queryErr
			break
		}
		value, err = s.service.Models(query.Provider)
	case "/api/resources":
		query, queryErr := wire.ReadQuery[wire.WorkspaceInput](r)
		if queryErr != nil {
			err = queryErr
			break
		}
		value, err = s.service.Resources(query.WorkspaceID)
	case "/api/artifacts":
		query, queryErr := wire.ReadQuery[wire.IDInput](r)
		if queryErr != nil {
			err = queryErr
			break
		}
		value, err = s.service.Artifacts(query.ID)
	case "/api/artifact-preview":
		query, queryErr := wire.ReadQuery[wire.ArtifactQuery](r)
		if queryErr != nil {
			err = queryErr
			break
		}
		value, err = s.service.PreviewArtifact(query.ID, query.Path)
	case "/api/draft":
		query, queryErr := wire.ReadQuery[desk.DraftScope](r)
		if queryErr != nil {
			err = queryErr
			break
		}
		value, err = s.service.Draft(query)
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
		query, queryErr := wire.ReadQuery[wire.IDInput](r)
		if queryErr != nil {
			err = queryErr
			break
		}
		var markdown string
		markdown, err = s.service.ExportConversation(query.ID)
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
		wire.WriteJSON(w, r.Method, r.URL.Path, value)
	}
	return true
}

func (s *Server) serveFeatureMutation(w http.ResponseWriter, r *http.Request, decode func(any) error) bool {
	var err error
	switch r.URL.Path {
	case "/api/draft":
		var in desk.DraftInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
			var draft desk.Draft
			draft, err = s.service.SaveDraft(in)
			if err == nil {
				wire.WriteJSON(w, r.Method, r.URL.Path, draft)
				return true
			}
		}
	case "/api/workspace-references":
		s.serveWorkspaceReferences(w, decode)
		return true
	case "/api/copy-text":
		var in wire.TextInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
			s.mu.Lock()
			copy := s.copyText
			s.mu.Unlock()
			if copy == nil {
				err = errors.New("Copy text directly in browser preview")
			} else if in.Text == "" {
				err = errors.New("Choose a response to copy")
			} else {
				err = copy(in.Text)
			}
		}
	case "/api/custom-connection":
		var in desk.CustomConnectionInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
			err = s.service.SaveCustomConnection(in)
		}
	case "/api/remove-model-connection":
		var in wire.IDInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
			err = s.service.RemoveModelConnection(in.ID)
		}
	case "/api/resource":
		var in desk.ResourceInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
			err = s.service.SaveResource(in)
		}
	case "/api/branch":
		var in wire.BranchInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
			err = s.service.BranchConversation(in.ID, in.NodeID, in.Before)
		}
	case "/api/compact":
		var in wire.IDInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
			err = s.service.CompactConversation(in.ID)
		}
	case "/api/oauth/start":
		var in wire.ProviderInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
			err = s.service.StartOAuth(in.Provider)
		}
	case "/api/oauth/answer":
		var in wire.OAuthAnswerInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
			err = s.service.AnswerOAuth(in.ID, in.Answer)
		}
	case "/api/oauth/cancel":
		s.service.CancelOAuth()
	case "/api/oauth/logout":
		var in wire.ProviderInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
			err = s.service.LogoutOAuth(in.Provider)
		}
	case "/api/provider-config":
		var in desk.ProviderConnectionInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
			err = s.service.ConfigureProvider(in)
		}
	case "/api/test-provider-connection":
		var in desk.ProviderConnectionInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
			var result desk.ConnectionTest
			result, err = s.service.TestProviderConnection(r.Context(), in)
			if err == nil {
				wire.WriteJSON(w, r.Method, r.URL.Path, result)
				return true
			}
		}
	case "/api/model-selection":
		var in wire.ModelSelectionInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
			err = s.service.SelectModel(in.Provider, in.Model, in.ThinkingLevel)
		}
	case "/api/test-connection":
		var in desk.ConfigInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
			var result desk.ConnectionTest
			result, err = s.service.TestConnection(r.Context(), in)
			if err == nil {
				wire.WriteJSON(w, r.Method, r.URL.Path, result)
				return true
			}
		}
	case "/api/continue":
		var in wire.IDInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
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
				wire.WriteJSON(w, r.Method, r.URL.Path, wire.NativeResponse{Native: save != nil})
				return true
			}
		}
	case "/api/export":
		var in wire.IDInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
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
					wire.WriteJSON(w, r.Method, r.URL.Path, wire.NativeResponse{Native: save != nil})
					return true
				}
			}
		}
	case "/api/queue":
		var in wire.QueueInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
			err = s.service.QueueMessage(in.ID, in.Text, in.Mode, in.Images...)
		}
	case "/api/queue/edit", "/api/queue/delete", "/api/queue/steer":
		var in wire.QueueMutationInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
			err = s.service.MutateQueuedMessage(in.ID, in.MessageID, strings.TrimPrefix(r.URL.Path, "/api/queue/"), in.Text)
		}
	case "/api/rename":
		var in wire.RenameInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
			err = s.service.RenameConversation(in.ID, in.Title)
		}
	case "/api/delete-conversation":
		var in wire.IDInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
			err = s.service.DeleteConversation(in.ID)
		}
	case "/api/remove-workspace":
		var in wire.RemoveWorkspaceInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
			if in.ConversationCount == nil {
				err = errors.New("Review the workspace's conversation count before removing it")
			} else {
				err = s.service.RemoveWorkspace(in.ID, *in.ConversationCount)
			}
		}
	case "/api/create-instructions":
		var in wire.WorkspaceInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
			var path string
			path, err = s.service.CreateInstructions(in.WorkspaceID)
			if err == nil {
				wire.WriteJSON(w, r.Method, r.URL.Path, wire.PathResponse{Path: path})
				return true
			}
		}
	case "/api/file":
		var in wire.FileInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
			var path string
			if in.Action == "copy" && in.Kind != "artifact" {
				err = errors.New("Copy a file produced by this conversation")
			} else {
				switch in.Kind {
				case "artifact":
					path, err = s.service.ResolveArtifactFile(in.ID, in.Path)
				case "resource":
					path, err = s.service.ResolveResourceFile(in.WorkspaceID, in.Path)
				default:
					err = errors.New("Choose a generated file or a discovered workspace resource")
				}
			}
			if err == nil {
				s.mu.Lock()
				open, reveal, copy := s.openFile, s.revealFile, s.copyFile
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
				case "copy":
					if copy == nil {
						err = errors.New("Copy files in the desktop app; use Copy path in browser preview")
					} else {
						err = copy(path)
					}
				default:
					err = errors.New("Choose open, reveal or copy")
				}
			}
		}
	case "/api/mcp/oauth/start", "/api/mcp/oauth/logout":
		var in wire.NameInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
			if r.URL.Path == "/api/mcp/oauth/start" {
				err = s.service.StartMCPOAuth(in.Name)
			} else {
				err = s.service.LogoutMCPOAuth(in.Name)
			}
		}
	case "/api/mcp/save":
		var in desk.MCPInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
			err = s.service.SaveMCP(in)
		}
	case "/api/mcp/remove":
		var in wire.NameInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
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
		wire.WriteJSON(w, r.Method, r.URL.Path, wire.OKResponse{OK: true})
	}
	return true
}
