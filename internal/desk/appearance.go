package desk

import (
	"errors"
	"path/filepath"
)

type AppearanceMode string

const (
	AppearanceSystem AppearanceMode = "system"
	AppearanceLight  AppearanceMode = "light"
	AppearanceDark   AppearanceMode = "dark"
)

func validAppearance(mode AppearanceMode) bool {
	return mode == AppearanceSystem || mode == AppearanceLight || mode == AppearanceDark
}

func normalizedAppearance(mode AppearanceMode) AppearanceMode {
	if !validAppearance(mode) {
		return AppearanceSystem
	}
	return mode
}

// SetAppearance is a UI preference and may change during an agent run. Copy the
// full saved configuration so changing the theme never erases model credentials.
func (s *Service) SetAppearance(mode AppearanceMode) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errors.New("Pith Desk has closed")
	}
	if !validAppearance(mode) {
		return errors.New("Choose system, light, or dark appearance")
	}
	next := s.config
	next.Appearance = mode
	if err := writeJSON(filepath.Join(s.dataDir, "settings.json"), next); err != nil {
		return err
	}
	s.config = next
	s.refreshSettingsLocked()
	s.changedLocked()
	return nil
}
