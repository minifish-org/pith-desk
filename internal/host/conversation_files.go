package host

import (
	"io"
	"mime"
	"net/http"

	"github.com/minifish-org/pith-desk/internal/wire"
)

// Desktop saves stream directly into a user-selected destination. Browser
// preview explicitly falls back to an authenticated attachment response.
func (s *Server) SetFileDownloadAction(save func(string, io.Reader) error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.saveFile = save
}

func (s *Server) serveConversationFile(w http.ResponseWriter, r *http.Request, in wire.ConversationFileInput) bool {
	name, file, err := s.service.OpenConversationFile(in.ID, in.Path)
	if err != nil {
		s.fail(w, err.Error(), http.StatusBadRequest)
		return true
	}
	defer file.Close()
	if r.Method == http.MethodGet {
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
		_, _ = io.Copy(w, file)
		return true
	}
	s.mu.Lock()
	save := s.saveFile
	s.mu.Unlock()
	if save != nil {
		if err := save(name, file); err != nil {
			s.fail(w, err.Error(), http.StatusBadRequest)
			return true
		}
	}
	wire.WriteJSON(w, r.Method, r.URL.Path, wire.FileDownloadResponse{Native: save != nil, Name: name})
	return true
}
