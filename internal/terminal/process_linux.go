package terminal

import (
	"errors"
	"golang.org/x/sys/unix"
	"os"
	"strconv"
)

func sessionKiller(pid int) (func(unix.Signal), error) {
	if session, err := unix.Getsid(pid); err != nil {
		return nil, err
	} else if session != pid || pid <= 1 || pid == unix.Getpid() {
		return nil, errors.New("Shell did not enter its own process session")
	}
	return func(signal unix.Signal) {
		entries, _ := os.ReadDir("/proc")
		for _, entry := range entries {
			child, err := strconv.Atoi(entry.Name())
			if err != nil || child <= 1 || child == pid || child == unix.Getpid() {
				continue
			}
			if session, err := unix.Getsid(child); err == nil && session == pid {
				_ = unix.Kill(child, signal)
			}
		}
		if session, err := unix.Getsid(pid); err == nil && session == pid {
			_ = unix.Kill(pid, signal)
		}
	}, nil
}
