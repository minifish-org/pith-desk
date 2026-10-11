package desk

import (
	"encoding/json"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
)

// Request, snapshot and persistence DTOs retain the existing wire and file contracts.
type Settings struct {
	Provider         string         `json:"provider"`
	ModelName        string         `json:"modelName"`
	ThinkingLevel    string         `json:"thinkingLevel"`
	ThinkingLevels   []string       `json:"thinkingLevels"`
	BaseURL          string         `json:"baseUrl"`
	Model            string         `json:"model"`
	HasConnections   bool           `json:"hasConnections"`
	HasAPIKey        bool           `json:"hasApiKey"`
	Appearance       AppearanceMode `json:"appearance"`
	SupportsImages   bool           `json:"supportsImages"`
	ImageUploadLimit int            `json:"imageUploadLimit"`
}

// An empty APIKey preserves only the same provider/endpoint key.
// ClearAPIKey explicitly removes that provider’s saved key.
type ConfigInput struct {
	Provider      string `json:"provider"`
	ThinkingLevel string `json:"thinkingLevel"`
	BaseURL       string `json:"baseUrl"`
	Model         string `json:"model"`
	APIKey        string `json:"apiKey,omitempty"`
	ClearAPIKey   bool   `json:"clearApiKey,omitempty"`
}

type Workspace struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Path string `json:"path"`
}

type Conversation struct {
	ID             string         `json:"id"`
	Title          string         `json:"title"`
	WorkspaceID    string         `json:"workspaceId"`
	UpdatedAt      string         `json:"updatedAt"`
	PermissionMode PermissionMode `json:"permissionMode"`
	CompletedRunID string         `json:"completedRunId,omitempty"`
	Unread         bool           `json:"unread,omitempty"`
}

type PermissionMode string

const (
	PermissionAsk            PermissionMode = "ask"
	PermissionWorkspaceWrite PermissionMode = "workspace-write"
	PermissionFullAccess     PermissionMode = "full-access"
)

func validPermissionMode(mode PermissionMode) bool {
	return mode == PermissionAsk || mode == PermissionWorkspaceWrite || mode == PermissionFullAccess
}

func normalizedPermissionMode(mode PermissionMode) PermissionMode {
	if !validPermissionMode(mode) {
		return PermissionAsk
	}
	return mode
}

func (mode PermissionMode) allows(tool string) bool {
	if mode == PermissionFullAccess {
		return tool == "write_file" || tool == "edit_file" || tool == "run_command"
	}
	return mode == PermissionWorkspaceWrite && (tool == "write_file" || tool == "edit_file")
}

type Message struct {
	ID           string          `json:"id"`
	Role         string          `json:"role"`
	Text         string          `json:"text"`
	ToolName     string          `json:"toolName,omitempty"`
	ToolCallID   string          `json:"toolCallId,omitempty"`
	Status       string          `json:"status,omitempty"`
	Images       []MessageImage  `json:"images,omitempty"`
	BranchNodeID string          `json:"branchNodeId,omitempty"`
	Command      *CommandDetails `json:"command,omitempty"`
}

type Approval struct {
	ID         string           `json:"id"`
	ToolName   string           `json:"toolName"`
	Args       json.RawMessage  `json:"args"`
	Warning    string           `json:"warning,omitempty"`
	Preview    *ApprovalPreview `json:"preview,omitempty"`
	fileReview *approvalFileReview
}

type State struct {
	Login         *LoginStatus   `json:"login,omitempty"`
	Settings      Settings       `json:"settings"`
	Workspaces    []Workspace    `json:"workspaces"`
	Conversations []Conversation `json:"conversations"`
	ActiveID      string         `json:"activeId"`
	Runs          []RunSummary   `json:"runs"`
	ConversationState
}

// ConversationState belongs to one conversation, independent of UI selection.
type ConversationState struct {
	Messages        []Message       `json:"messages"`
	QueuedMessages  []QueuedMessage `json:"queuedMessages"`
	Running         bool            `json:"running"`
	PendingApproval *Approval       `json:"pendingApproval,omitempty"`
	Error           string          `json:"error,omitempty"`
	Runtime         RuntimeStatus   `json:"runtime"`
	Failure         *Failure        `json:"failure,omitempty"`
}

type savedConfig struct {
	AuthPath      string                     `json:"-"`
	Provider      string                     `json:"provider"`
	ThinkingLevel string                     `json:"thinkingLevel"`
	Connections   map[string]savedConnection `json:"connections,omitempty"`
	BaseURL       string                     `json:"baseUrl"`
	Model         string                     `json:"model"`
	APIKey        string                     `json:"apiKey,omitempty"`
	Appearance    AppearanceMode             `json:"appearance"`
}

type RunSummary struct {
	ConversationID string `json:"conversationId"`
	WorkspaceID    string `json:"workspaceId"`
	Phase          string `json:"phase"`
	NeedsApproval  bool   `json:"needsApproval"`
}

type QueueMode string

const (
	QueueSteer    = "steer"
	QueueFollowUp = "follow-up"
)

type QueuedMessage struct {
	ID         string                 `json:"id"`
	Text       string                 `json:"text"`
	Mode       QueueMode              `json:"mode"`
	Images     []aitypes.ImageContent `json:"-"`
	ImageCount int                    `json:"imageCount,omitempty"`
}
