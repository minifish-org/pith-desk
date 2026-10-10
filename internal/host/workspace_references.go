package host

import (
	"net/http"

	"github.com/minifish-org/pith-desk/internal/wire"
)

// SetNativeFileDrop marks the desktop's explicit path event bridge. It grants
// no file access: every dropped path still goes through the workspace policy.
func (s *Server) SetNativeFileDrop(enabled bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nativeFileDrop = enabled
}

func (s *Server) serveWorkspaceReferences(w http.ResponseWriter, decode func(any) error) {
	var in wire.WorkspaceReferencesInput
	if err := wire.Decode("/api/workspace-references", decode, &in); err != nil {
		s.fail(w, err.Error(), http.StatusBadRequest)
		return
	}
	refs, err := s.service.WorkspaceFileReferences(in.WorkspaceID, in.Paths)
	if err != nil {
		s.fail(w, err.Error(), http.StatusBadRequest)
		return
	}
	wire.WriteJSON(w, "POST", "/api/workspace-references", wire.WorkspaceReferencesResponse{Paths: refs})
}
