package desk

import (
	"errors"
	"sync"
)

// PauseTaskAdmission keeps the task confirmation valid while an update is
// downloading. Existing tasks continue; draft saves remain available. Restore
// admission on cancellation or failure, and leave it paused on successful exit.
func (s *Service) PauseTaskAdmission() (func(), error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.restarting {
		return nil, errors.New("Pith Desk is already closing or updating")
	}
	s.restarting = true
	var once sync.Once
	return func() { once.Do(func() { s.mu.Lock(); s.restarting = false; s.mu.Unlock() }) }, nil
}
