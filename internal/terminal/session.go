// Package terminal owns manual shells. It has no Agent, transcript or credential dependency.
package terminal

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

const HistoryLimit = 1 << 20
const ChunkLimit = 32 << 10
const SessionLimit = 16

type Info struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspaceId"`
	Directory   string `json:"directory"`
	Shell       string `json:"shell"`
	Running     bool   `json:"running"`
	Cols        int    `json:"cols"`
	Rows        int    `json:"rows"`
	ExitCode    int    `json:"exitCode"`
}

type Manager struct {
	mu       sync.Mutex
	sessions map[string]*Session
	closed   bool
}

func New() *Manager { return &Manager{sessions: make(map[string]*Session)} }

// A stable tab ID makes Open idempotent, including after its shell exits.
// Different IDs in the same workspace own independent process sessions.
func (m *Manager) Open(id, workspace, directory string, cols, rows int) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, errors.New("Terminal service has stopped")
	}
	if id == "" || workspace == "" {
		return nil, errors.New("Terminal and workspace IDs are required")
	}
	if s := m.sessions[id]; s != nil {
		if s.Info().WorkspaceID != workspace {
			return nil, errors.New("Terminal belongs to another workspace")
		}
		return s, nil
	}
	if len(m.sessions) >= SessionLimit {
		return nil, errors.New("Close an unused terminal before opening another (limit 16)")
	}
	if err := ValidateSize(cols, rows); err != nil {
		return nil, err
	}
	s, err := start(id, workspace, directory, cols, rows)
	if err != nil {
		return nil, err
	}
	m.sessions[id] = s
	return s, nil
}

func (m *Manager) Get(workspace, id string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var s *Session
	for key, candidate := range m.sessions {
		if candidate.Info().WorkspaceID == workspace && (id == "" || key == id) && (s == nil || key < s.Info().ID) {
			s = candidate
		}
	}
	if m.closed || s == nil {
		return nil, errors.New("Terminal session is no longer available")
	}
	return s, nil
}

func (m *Manager) List(workspace string) []Info {
	m.mu.Lock()
	defer m.mu.Unlock()
	result := make([]Info, 0)
	if !m.closed {
		for _, session := range m.sessions {
			if info := session.Info(); info.WorkspaceID == workspace {
				result = append(result, info)
			}
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result
}

func (m *Manager) CloseSession(workspace, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s := m.sessions[id]; s != nil && s.Info().WorkspaceID != workspace {
		return errors.New("Terminal belongs to another workspace")
	}
	for key, session := range m.sessions {
		if session.Info().WorkspaceID == workspace && (id == "" || key == id) {
			session.Close()
			delete(m.sessions, key)
		}
	}
	return nil
}

func (m *Manager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closed = true
	for workspace, s := range m.sessions {
		s.Close()
		delete(m.sessions, workspace)
	}
}

type Session struct {
	mu          sync.Mutex
	ioMu        sync.Mutex
	info        Info
	file        *os.File
	fd          int
	cmd         *exec.Cmd
	history     []byte
	end         uint64
	changed     chan struct{}
	done        chan struct{}
	processDone chan struct{}
	stopOnce    sync.Once
	kill        func(unix.Signal)
}

func ValidateSize(cols, rows int) error {
	if cols < 2 || cols > 500 || rows < 1 || rows > 300 {
		return errors.New("Terminal size must be 2–500 columns and 1–300 rows")
	}
	return nil
}

func start(id, workspace, directory string, cols, rows int) (*Session, error) {
	shell := interactiveShell()
	cmd := exec.Command(shell, "-i")
	cmd.Dir = directory
	cmd.Env = shellEnvironment(shell)
	file, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		return nil, fmt.Errorf("Start terminal: %w", err)
	}
	// Make blocking reads/writes interruptible by Close and write deadlines.
	fd, err := unix.Dup(int(file.Fd()))
	_ = file.Close()
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return nil, err
	}
	unix.CloseOnExec(fd)
	if err = unix.SetNonblock(fd, true); err != nil {
		_ = unix.Close(fd)
		_ = cmd.Process.Kill()
		_ = file.Close()
		_ = cmd.Wait()
		return nil, err
	}
	// NewFile sees O_NONBLOCK and registers the descriptor with Go's poller.
	file = os.NewFile(uintptr(fd), "terminal-pty")
	kill, err := sessionKiller(cmd.Process.Pid)
	if err != nil {
		_ = cmd.Process.Kill()
		_ = file.Close()
		_ = cmd.Wait()
		return nil, err
	}
	s := &Session{info: Info{ID: id, WorkspaceID: workspace, Directory: directory, Shell: shell, Running: true, Cols: cols, Rows: rows, ExitCode: -1}, file: file, fd: fd, cmd: cmd,
		history: make([]byte, HistoryLimit), changed: make(chan struct{}), done: make(chan struct{}), processDone: make(chan struct{}), kill: kill}
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		buffer := make([]byte, ChunkLimit)
		for {
			n, err := file.Read(buffer)
			if n > 0 {
				s.append(buffer[:n])
			}
			if err != nil {
				return
			}
		}
	}()
	go func() {
		err := cmd.Wait()
		close(s.processDone)
		// Drain the final write on ordinary exit, without waiting indefinitely
		// for background jobs that still hold the slave open.
		select {
		case <-readDone:
		case <-time.After(100 * time.Millisecond):
		}
		s.stop()
		<-readDone
		s.mu.Lock()
		s.info.Running = false
		s.info.ExitCode = 0
		if err != nil {
			s.info.ExitCode = cmd.ProcessState.ExitCode()
		}
		s.notifyLocked()
		s.mu.Unlock()
		close(s.done)
	}()
	return s, nil
}

func (s *Session) notifyLocked() { close(s.changed); s.changed = make(chan struct{}) }
func (s *Session) append(data []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for len(data) > 0 {
		at := int(s.end % uint64(len(s.history)))
		n := copy(s.history[at:], data)
		s.end += uint64(n)
		data = data[n:]
	}
	s.notifyLocked()
}

func (s *Session) Info() Info { s.mu.Lock(); defer s.mu.Unlock(); return s.info }

// Read never waits on a page. Its bounded copy and wakeup are captured atomically.
func (s *Session) Read(offset uint64) (data []byte, start, end uint64, truncated bool, info Info, changed <-chan struct{}) {
	s.mu.Lock()
	defer s.mu.Unlock()
	base := uint64(0)
	if s.end > uint64(len(s.history)) {
		base = s.end - uint64(len(s.history))
	}
	if offset < base {
		offset = base
		truncated = true
	}
	if offset > s.end {
		offset = s.end
	}
	start = offset
	n := min(s.end-offset, ChunkLimit)
	data = make([]byte, int(n))
	at := int(offset % uint64(len(s.history)))
	copied := copy(data, s.history[at:])
	copy(data[copied:], s.history)
	return data, start, offset + n, truncated, s.info, s.changed
}

func (s *Session) Write(data []byte) error {
	if len(data) == 0 || len(data) > 16<<10 {
		return errors.New("Terminal input is limited to 16 KiB per message")
	}
	s.ioMu.Lock()
	defer s.ioMu.Unlock()
	if !s.Info().Running {
		return errors.New("Terminal has exited")
	}
	if err := s.file.SetWriteDeadline(time.Now().Add(250 * time.Millisecond)); err != nil {
		return err
	}
	_, err := s.file.Write(data)
	return err
}

func (s *Session) Resize(cols, rows int) error {
	if err := ValidateSize(cols, rows); err != nil {
		return err
	}
	s.ioMu.Lock()
	defer s.ioMu.Unlock()
	if !s.Info().Running {
		return errors.New("Terminal has exited")
	}
	if err := pty.Setsize(s.file, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)}); err != nil {
		return err
	}
	s.mu.Lock()
	s.info.Cols = cols
	s.info.Rows = rows
	s.mu.Unlock()
	// Also request a redraw when reconnecting at exactly the previous size.
	if group, err := unix.IoctlGetInt(s.fd, unix.TIOCGPGRP); err == nil && group > 0 {
		_ = unix.Kill(-group, unix.SIGWINCH)
	}
	return nil
}

func (s *Session) stop() {
	s.stopOnce.Do(func() {
		s.kill(unix.SIGTERM)
		select {
		case <-s.processDone:
		case <-time.After(150 * time.Millisecond):
		}
		s.kill(unix.SIGKILL)
		s.ioMu.Lock()
		_ = s.file.Close()
		s.ioMu.Unlock()
	})
}
func (s *Session) Close() { s.stop(); <-s.done }

func executable(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0111 != 0 && filepath.IsAbs(path)
}
func interactiveShell() string {
	candidates := []string{os.Getenv("SHELL")}
	if current, err := user.Current(); err == nil {
		if passwd, err := os.ReadFile("/etc/passwd"); err == nil {
			for _, line := range strings.Split(string(passwd), "\n") {
				fields := strings.Split(line, ":")
				if len(fields) == 7 && fields[2] == current.Uid {
					candidates = append(candidates, fields[6])
				}
			}
		}
		if runtime.GOOS == "darwin" && !executable(candidates[0]) {
			if output, err := exec.Command("/usr/bin/dscl", ".", "-read", "/Users/"+current.Username, "UserShell").Output(); err == nil {
				candidates = append(candidates, strings.TrimSpace(strings.TrimPrefix(string(output), "UserShell:")))
			}
		}
	}
	candidates = append(candidates, "/bin/zsh", "/bin/bash", "/bin/sh")
	for _, candidate := range candidates {
		if executable(candidate) {
			return candidate
		}
	}
	return "/bin/sh"
}

// An allowlist, never os.Environ: app tokens, model keys and MCP credentials
// are not inherited. The user's own shell startup files still run as that user.
func shellEnvironment(shell string) []string {
	env := []string{"TERM=xterm-256color", "COLORTERM=truecolor", "SHELL=" + shell}
	path := os.Getenv("PATH")
	if path == "" {
		path = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
	}
	env = append(env, "PATH="+path)
	if current, err := user.Current(); err == nil {
		env = append(env, "HOME="+current.HomeDir, "USER="+current.Username, "LOGNAME="+current.Username)
	}
	lang := os.Getenv("LANG")
	if lang == "" {
		if runtime.GOOS == "darwin" {
			lang = "en_US.UTF-8"
		} else {
			lang = "C.UTF-8"
		}
	}
	env = append(env, "LANG="+lang)
	for _, key := range []string{"LC_ALL", "LC_CTYPE", "LC_MESSAGES", "LC_COLLATE", "LC_NUMERIC", "LC_TIME", "TZ", "TMPDIR"} {
		if value := os.Getenv(key); value != "" {
			env = append(env, key+"="+value)
		}
	}
	return env
}
