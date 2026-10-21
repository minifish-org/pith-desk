package terminal

import (
	"errors"
	"golang.org/x/sys/unix"
)

// Job control creates multiple process groups. Match the kernel session,
// including background jobs reparented after their shell exits.
func sessionKiller(pid int) (func(unix.Signal), error) {
	session, err := unix.Getsid(pid)
	if err != nil {
		return nil, err
	}
	if session != pid || pid <= 1 || pid == unix.Getpid() {
		return nil, errors.New("Shell did not enter its own process session")
	}
	return func(signal unix.Signal) {
		processes, err := unix.SysctlKinfoProcSlice("kern.proc.uid", unix.Getuid())
		if err != nil {
			_ = unix.Kill(-pid, signal)
			return
		}
		for _, process := range processes {
			child := int(process.Proc.P_pid)
			// macOS redacts Eproc.Sess to zero. Compare the public session ID,
			// never a kernel pointer or an unverified process/group identifier.
			if child > 1 && child != pid && child != unix.Getpid() {
				if sid, err := unix.Getsid(child); err == nil && sid == session {
					_ = unix.Kill(child, signal)
				}
			}
		}
		if sid, err := unix.Getsid(pid); err == nil && sid == session {
			_ = unix.Kill(pid, signal)
		}
	}, nil
}
