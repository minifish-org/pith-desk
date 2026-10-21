package desk

import (
	"errors"
	"path/filepath"
)

// SidebarWidths are UI preferences in CSS pixels. Pith UI owns the actual
// layout limits; this boundary accepts only bounded positive integer values.
type SidebarWidths struct {
	Navigation int `json:"navigation"`
	Tools      int `json:"tools"`
}

func (s *Service) SetSidebarWidths(widths SidebarWidths) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errors.New("Pith Desk has closed")
	}
	if widths.Navigation < 1 || widths.Navigation > 4096 || widths.Tools < 1 || widths.Tools > 4096 {
		return errors.New("Sidebar widths must be integers between 1 and 4096")
	}
	next := s.connections.config
	if next.NavigationWidth == widths.Navigation && next.ToolsWidth == widths.Tools {
		return nil
	}
	next.NavigationWidth, next.ToolsWidth = widths.Navigation, widths.Tools
	if err := s.files.WriteJSON(filepath.Join(s.dataDir, "settings.json"), next); err != nil {
		return err
	}
	s.connections.commitConfig(next)
	s.changedLocked()
	return nil
}
