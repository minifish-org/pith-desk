// Package wire is the JSON contract of the authenticated loopback host.
// It deliberately does not import host or the embedded frontend assets.
package wire

import (
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strconv"
	"strings"

	"github.com/minifish-org/pith-desk/internal/desk"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
)

type EmptyInput struct{}
type ServerLoginInput struct {
	Token string `json:"token"`
}
type ServerLeaseInput struct {
	Resume   string `json:"resume,omitempty"`
	Takeover bool   `json:"takeover,omitempty"`
}
type ServerSessionResponse struct {
	Authenticated bool `json:"authenticated"`
}
type ServerLeaseResponse struct {
	Lease     string `json:"lease"`
	ExpiresIn int    `json:"expiresIn"`
}
type UpdateInput struct {
	Action string `json:"action"`
}
type UpdateStatus struct {
	Version          string  `json:"version"`
	Enabled          bool    `json:"enabled"`
	Phase            string  `json:"phase"`
	AvailableVersion string  `json:"availableVersion"`
	Progress         float64 `json:"progress"`
	Message          string  `json:"message"`
}
type IDInput struct {
	ID string `json:"id"`
}
type WorkspaceInput struct {
	WorkspaceID string `json:"workspaceId"`
}
type PathInput struct {
	Path string `json:"path"`
}
type TextInput struct {
	Text string `json:"text"`
}
type NameInput struct {
	Name string `json:"name"`
}
type ProviderInput struct {
	Provider string `json:"provider"`
}
type AppearanceInput struct {
	Mode desk.AppearanceMode `json:"mode"`
}
type ReadInput struct {
	ID    string `json:"id"`
	RunID string `json:"runId"`
}
type SendInput struct {
	ID     string                 `json:"id"`
	Text   string                 `json:"text"`
	Images []aitypes.ImageContent `json:"images,omitempty"`
}
type QueueInput struct {
	ID     string                 `json:"id"`
	Text   string                 `json:"text"`
	Mode   string                 `json:"mode,omitempty"`
	Images []aitypes.ImageContent `json:"images,omitempty"`
}
type EditMessageInput struct {
	ID                    string `json:"id"`
	MessageID             string `json:"messageId"`
	ExpectedLastMessageID string `json:"expectedLastMessageId"`
	Text                  string `json:"text"`
}
type QueueMutationInput struct {
	ID        string `json:"id"`
	MessageID string `json:"messageId"`
	Text      string `json:"text,omitempty"`
}
type ApprovalInput struct {
	ID          string `json:"id"`
	Allow       bool   `json:"allow"`
	AlwaysAllow bool   `json:"alwaysAllow,omitempty"`
}
type PermissionsInput struct {
	ID   string              `json:"id"`
	Mode desk.PermissionMode `json:"mode"`
}
type BranchInput struct {
	ID     string `json:"id"`
	NodeID string `json:"nodeId"`
	Before bool   `json:"before,omitempty"`
}
type OAuthAnswerInput struct {
	ID     string `json:"id"`
	Answer string `json:"answer"`
}
type ModelSelectionInput struct {
	Provider      string `json:"provider"`
	Model         string `json:"model"`
	ThinkingLevel string `json:"thinkingLevel"`
}
type RenameInput struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}
type RemoveWorkspaceInput struct {
	ID                string `json:"id"`
	ConversationCount *int   `json:"conversationCount"`
}
type FileInput struct {
	Kind        string `json:"kind"`
	ID          string `json:"id,omitempty"`
	WorkspaceID string `json:"workspaceId,omitempty"`
	Path        string `json:"path"`
	Action      string `json:"action"`
}
type WorkspaceReferencesInput struct {
	WorkspaceID string   `json:"workspaceId"`
	Paths       []string `json:"paths"`
}
type NativeMenuStateInput struct {
	Ready       bool   `json:"ready"`
	Busy        bool   `json:"busy"`
	Modal       bool   `json:"modal"`
	WorkspaceID string `json:"workspaceId"`
	ActiveID    string `json:"activeId"`
}
type ResourceQuery struct {
	WorkspaceID string `json:"workspaceId"`
	Path        string `json:"path"`
}
type WorkspaceFilesQuery struct {
	WorkspaceID string `json:"workspaceId"`
	Path        string `json:"path"`
	Query       string `json:"query,omitempty"`
}
type ArtifactQuery struct {
	ID   string `json:"id"`
	Path string `json:"path"`
}
type ConversationFileInput struct {
	ID   string `json:"id"`
	Path string `json:"path"`
}
type FileDownloadResponse struct {
	Native bool   `json:"native"`
	Name   string `json:"name"`
}
type ModelsQuery struct {
	Provider string `json:"provider,omitempty"`
}
type ImageQuery struct {
	ID      string `json:"id"`
	Message string `json:"message"`
	Index   int    `json:"index"`
}
type OKResponse struct {
	OK bool `json:"ok"`
}
type ErrorResponse struct {
	Error string `json:"error"`
}
type PathResponse struct {
	Path string `json:"path"`
}
type NativeResponse struct {
	Native bool `json:"native"`
}
type ConversationResponse struct {
	Conversation desk.Conversation `json:"conversation"`
}

type WorkspaceResponse struct {
	OK        bool           `json:"ok"`
	Workspace desk.Workspace `json:"workspace"`
}
type WorkspaceReferencesResponse struct {
	Paths []string `json:"paths"`
}
type ResourceContentResponse struct {
	Content string `json:"content"`
}

// Endpoint records the types actually decoded and encoded by the host. The
// generator checks host route coverage and decoder declarations against it.
type Endpoint struct {
	Method string
	Path   string
	Input  reflect.Type
	Query  reflect.Type
	Output reflect.Type
	Format string // json, text, blob, or stream
}

func post[I, O any](path string) Endpoint {
	return Endpoint{Method: "POST", Path: path, Input: reflect.TypeFor[I](), Output: reflect.TypeFor[O](), Format: "json"}
}
func get[Q, O any](path string) Endpoint {
	return Endpoint{Method: "GET", Path: path, Query: reflect.TypeFor[Q](), Output: reflect.TypeFor[O](), Format: "json"}
}

var Endpoints = []Endpoint{
	get[WorkspaceInput, TerminalResponse]("/api/terminal"),
	post[TerminalOpenInput, TerminalResponse]("/api/terminal"),
	post[TerminalTarget, OKResponse]("/api/terminal/close"),
	{Method: "GET", Path: "/api/terminal/socket", Query: reflect.TypeFor[TerminalTarget](), Input: reflect.TypeFor[TerminalControl](), Output: reflect.TypeFor[TerminalEvent](), Format: "stream"},
	post[EmptyInput, ServerSessionResponse]("/api/server/session"),
	post[ServerLoginInput, OKResponse]("/api/server/login"),
	post[ServerLeaseInput, ServerLeaseResponse]("/api/server/lease"),
	post[EmptyInput, OKResponse]("/api/server/heartbeat"),
	post[EmptyInput, OKResponse]("/api/server/logout"),
	get[EmptyInput, UpdateStatus]("/api/update"),
	post[UpdateInput, OKResponse]("/api/update"),
	get[EmptyInput, desk.State]("/api/state"),
	get[IDInput, []desk.HistoryNode]("/api/history"),
	get[IDInput, desk.CostReport]("/api/costs"),
	get[ResourceQuery, ResourceContentResponse]("/api/resource-content"),
	get[IDInput, desk.CustomConnectionInput]("/api/custom-connection"),
	get[ModelsQuery, desk.ModelCatalog]("/api/models"),
	get[WorkspaceInput, desk.ResourceInventory]("/api/resources"),
	get[IDInput, []desk.Artifact]("/api/artifacts"),
	get[ArtifactQuery, desk.ArtifactPreview]("/api/artifact-preview"),
	get[WorkspaceFilesQuery, desk.WorkspaceListing]("/api/workspace-files"),
	get[ResourceQuery, desk.ArtifactPreview]("/api/workspace-preview"),
	get[desk.DraftScope, desk.Draft]("/api/draft"),
	get[EmptyInput, []desk.MCPServerView]("/api/mcp"),
	{Method: "GET", Path: "/api/diagnostics", Format: "blob"},
	{Method: "GET", Path: "/api/export", Query: reflect.TypeFor[IDInput](), Format: "blob"},
	{Method: "GET", Path: "/api/image", Query: reflect.TypeFor[ImageQuery](), Format: "blob"},
	{Method: "GET", Path: "/api/conversation-file", Query: reflect.TypeFor[ConversationFileInput](), Format: "blob"},
	{Method: "GET", Path: "/api/workspace-file", Query: reflect.TypeFor[ResourceQuery](), Format: "blob"},
	{Method: "GET", Path: "/api/socket", Output: reflect.TypeFor[desk.State](), Format: "stream"},
	{Method: "GET", Path: "/api/events", Output: reflect.TypeFor[desk.State](), Format: "stream"},
	post[desk.ConfigInput, OKResponse]("/api/config"),
	post[AppearanceInput, OKResponse]("/api/appearance"),
	post[PathInput, WorkspaceResponse]("/api/workspaces"),
	post[WorkspaceInput, ConversationResponse]("/api/conversations"),
	post[IDInput, OKResponse]("/api/open"),
	post[ReadInput, OKResponse]("/api/read"),
	post[SendInput, OKResponse]("/api/send"),
	post[EditMessageInput, OKResponse]("/api/edit-message"),
	post[IDInput, OKResponse]("/api/abort"),
	post[ApprovalInput, OKResponse]("/api/approval"),
	post[PermissionsInput, OKResponse]("/api/permissions"),
	post[EmptyInput, PathResponse]("/api/pick-workspace"),
	post[WorkspaceReferencesInput, WorkspaceReferencesResponse]("/api/workspace-references"),
	post[TextInput, OKResponse]("/api/copy-text"),
	post[desk.DraftInput, desk.Draft]("/api/draft"),
	post[desk.CustomConnectionInput, OKResponse]("/api/custom-connection"),
	post[IDInput, OKResponse]("/api/remove-model-connection"),
	post[desk.ResourceInput, OKResponse]("/api/resource"),
	post[BranchInput, OKResponse]("/api/branch"),
	post[IDInput, OKResponse]("/api/compact"),
	post[ProviderInput, OKResponse]("/api/oauth/start"),
	post[OAuthAnswerInput, OKResponse]("/api/oauth/answer"),
	post[EmptyInput, OKResponse]("/api/oauth/cancel"),
	post[ProviderInput, OKResponse]("/api/oauth/logout"),
	post[desk.ProviderConnectionInput, OKResponse]("/api/provider-config"),
	post[desk.ProviderConnectionInput, desk.ConnectionTest]("/api/test-provider-connection"),
	post[ModelSelectionInput, OKResponse]("/api/model-selection"),
	post[desk.ConfigInput, desk.ConnectionTest]("/api/test-connection"),
	post[IDInput, OKResponse]("/api/continue"),
	post[EmptyInput, NativeResponse]("/api/diagnostics"),
	post[IDInput, NativeResponse]("/api/export"),
	post[ConversationFileInput, FileDownloadResponse]("/api/conversation-file"),
	post[ResourceQuery, FileDownloadResponse]("/api/workspace-file"),
	post[QueueInput, OKResponse]("/api/queue"),
	post[QueueMutationInput, OKResponse]("/api/queue/edit"),
	post[QueueMutationInput, OKResponse]("/api/queue/delete"),
	post[QueueMutationInput, OKResponse]("/api/queue/steer"),
	post[RenameInput, OKResponse]("/api/rename"),
	post[IDInput, OKResponse]("/api/delete-conversation"),
	post[RemoveWorkspaceInput, OKResponse]("/api/remove-workspace"),
	post[WorkspaceInput, PathResponse]("/api/create-instructions"),
	post[FileInput, OKResponse]("/api/file"),
	post[NameInput, OKResponse]("/api/mcp/oauth/start"),
	post[NameInput, OKResponse]("/api/mcp/oauth/logout"),
	post[desk.MCPInput, OKResponse]("/api/mcp/save"),
	post[NameInput, OKResponse]("/api/mcp/remove"),
	post[EmptyInput, OKResponse]("/api/mcp/connect"),
	post[EmptyInput, OKResponse]("/api/mcp/disconnect"),
	post[NativeMenuStateInput, OKResponse]("/api/native-menu-state"),
}

// Decode also catches an accidental handler/registry mismatch at the host
// boundary. It preserves the existing size limits and strict JSON decoding.
func Decode(path string, decode func(any) error, dst any) error {
	for _, endpoint := range Endpoints {
		if endpoint.Method == "POST" && endpoint.Path == path {
			if reflect.TypeOf(dst) != reflect.PointerTo(endpoint.Input) {
				return fmt.Errorf("request contract mismatch for %s", path)
			}
			return decode(dst)
		}
	}
	return fmt.Errorf("unregistered request contract for %s", path)
}

// ReadQuery uses the same Go JSON names that generate the TS query fields.
// String validation remains with the service; numeric parsing matches the
// existing image-index boundary. Unknown query keys remain ignored.
func ReadQuery[Q any](r *http.Request) (Q, error) {
	var query Q
	typ := reflect.TypeFor[Q]()
	registered := false
	for _, endpoint := range Endpoints {
		if endpoint.Method == "GET" && endpoint.Path == r.URL.Path && endpoint.Query == typ {
			registered = true
			break
		}
	}
	if !registered {
		return query, fmt.Errorf("query contract mismatch for %s", r.URL.Path)
	}
	value := reflect.ValueOf(&query).Elem()
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		name := strings.Split(field.Tag.Get("json"), ",")[0]
		raw := r.URL.Query().Get(name)
		switch value.Field(i).Kind() {
		case reflect.String:
			value.Field(i).SetString(raw)
		case reflect.Int:
			parsed, err := strconv.Atoi(raw)
			if err != nil {
				return query, fmt.Errorf("invalid %s query value", name)
			}
			value.Field(i).SetInt(int64(parsed))
		default:
			return query, fmt.Errorf("unsupported %s query field", name)
		}
	}
	return query, nil
}

// WriteJSON keeps the response schema tied to the host's real result type.
// A stale endpoint registration fails closed instead of emitting a different
// success shape from the one the frontend was compiled against.
func WriteJSON(w http.ResponseWriter, method, path string, value any) {
	for _, endpoint := range Endpoints {
		if endpoint.Method == method && endpoint.Path == path && endpoint.Format == "json" {
			if reflect.TypeOf(value) == endpoint.Output {
				_ = json.NewEncoder(w).Encode(value)
				return
			}
			break
		}
	}
	w.WriteHeader(http.StatusInternalServerError)
	_ = json.NewEncoder(w).Encode(ErrorResponse{Error: "Response contract mismatch"})
}
