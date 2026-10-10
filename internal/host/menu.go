package host

import (
	"errors"

	"github.com/minifish-org/pith-desk/internal/desk"
	"github.com/minifish-org/pith-desk/internal/wire"
)

// NativeMenuStateInput carries UI-only state. Running tasks and conversation
// identities are read from the service instead of trusting the page.
type NativeMenuStateInput = wire.NativeMenuStateInput

// SetNativeMenuAction installs the desktop menu observer. Its initial value and
// subsequent inputs are ordered under the broadcaster's lock. The callback must
// return promptly and must not call back into Server.
func (s *Server) SetNativeMenuAction(action func(desk.State, NativeMenuStateInput)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.nativeMenuAction != nil {
		s.nativeMenuAction(s.service.Snapshot(), NativeMenuStateInput{})
	}
	s.nativeMenuInput = NativeMenuStateInput{}
	s.nativeMenuAction = action
	if action != nil {
		action(s.service.Snapshot(), s.nativeMenuInput)
	}
}

// SetNativeMenuState is called only after the host authenticates the page. An
// empty input disables page actions while a replacement document loads.
func (s *Server) SetNativeMenuState(input NativeMenuStateInput) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.nativeMenuAction == nil {
		return errors.New("Native menus are unavailable")
	}
	s.nativeMenuInput = input
	s.updateNativeMenuLocked(s.service.Snapshot())
	return nil
}

func (s *Server) updateNativeMenuLocked(state desk.State) {
	if s.nativeMenuAction != nil {
		s.nativeMenuAction(state, s.nativeMenuInput)
	}
}

func (s *Server) clearNativeMenuAction() {
	s.SetNativeMenuAction(nil)
}
