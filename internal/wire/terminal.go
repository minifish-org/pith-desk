package wire

import "github.com/minifish-org/pith-desk/internal/terminal"

type TerminalOpenInput struct {
	WorkspaceID string `json:"workspaceId"`
	Cols        int    `json:"cols"`
	Rows        int    `json:"rows"`
}
type TerminalTarget struct {
	WorkspaceID string `json:"workspaceId"`
	ID          string `json:"id"`
}
type TerminalResponse struct {
	Session  *terminal.Info `json:"session"`
	Location string         `json:"location"`
}

// Output is separate from application snapshots. Data is base64 of raw PTY
// bytes so UTF-8 and escape sequences can span arbitrary reads losslessly.
type TerminalEvent struct {
	Type      string         `json:"type"`
	Session   *terminal.Info `json:"session,omitempty"`
	Data      string         `json:"data,omitempty"`
	Start     uint64         `json:"start"`
	End       uint64         `json:"end"`
	Truncated bool           `json:"truncated,omitempty"`
}
type TerminalControl struct {
	Type string `json:"type"`
	Data string `json:"data,omitempty"`
	Cols int    `json:"cols,omitempty"`
	Rows int    `json:"rows,omitempty"`
	End  uint64 `json:"end,omitempty"`
}
