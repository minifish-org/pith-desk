package terminal

import (
	"bytes"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/minifish-org/pith-desk/internal/testsupport/shellfixture"
	"golang.org/x/sys/unix"
)

func readUntil(t *testing.T, s *Session, cursor *uint64, expected string) string {
	t.Helper()
	var output strings.Builder
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	for {
		data, _, end, _, _, changed := s.Read(*cursor)
		*cursor = end
		output.Write(data)
		if strings.Contains(output.String(), expected) {
			return output.String()
		}
		select {
		case <-changed:
		case <-deadline.C:
			t.Fatalf("waiting for %q, got %q", expected, output.String())
			return ""
		}
	}
}

func testSession(t *testing.T) (*Manager, *Session) {
	t.Helper()
	shell, err := shellfixture.Create(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("SHELL", shell)
	m := New()
	t.Cleanup(m.Close)
	s, err := m.Open("session", "workspace", t.TempDir(), 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Write([]byte("stty -echo; printf '\\nSHELL_READY_%s\\n' ok\n")); err != nil {
		t.Fatal(err)
	}
	var cursor uint64
	readUntil(t, s, &cursor, "SHELL_READY_ok")
	return m, s
}

func TestRealShellIsolationUnicodeResizeInterruptAndReconnect(t *testing.T) {
	m, s := testSession(t)
	var cursor uint64
	if err := s.Write([]byte("printf 'READY\\n'; pwd; export MANUAL_ONLY=terminal\n")); err != nil {
		t.Fatal(err)
	}
	readUntil(t, s, &cursor, "READY")
	if os.Getenv("MANUAL_ONLY") != "" {
		t.Fatal("shell changed application environment")
	}
	if err := s.Resize(101, 37); err != nil {
		t.Fatal(err)
	}
	if err := s.Write([]byte("stty size; printf '\\344'; sleep .05; printf '\\270\\255\\346\\226\\207'; printf '\\nUNICODE_DONE\\n'\n")); err != nil {
		t.Fatal(err)
	}
	output := readUntil(t, s, &cursor, "UNICODE_DONE")
	if !strings.Contains(output, "37 101") || !strings.Contains(output, "中文") {
		t.Fatalf("size or UTF8 lost: %q", output)
	}
	if same, err := m.Open("replacement", "workspace", s.Info().Directory, 80, 24); err != nil || same != s {
		t.Fatal("reconnect started another shell", err)
	}
	if err := s.Write([]byte("sleep 60\n")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(80 * time.Millisecond)
	if err := s.Write([]byte{3}); err != nil {
		t.Fatal(err)
	}
	if err := s.Write([]byte("printf '\\nINTERRUPTED\\n'\n")); err != nil {
		t.Fatal(err)
	}
	readUntil(t, s, &cursor, "INTERRUPTED")
	// No subscriber is needed to drain PTY output or complete a file write.
	if err := s.Write([]byte("(sleep .1; printf detached > after-disconnect; printf '\\nDETACHED_DONE\\n') &\n")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(250 * time.Millisecond)
	data, err := os.ReadFile(filepath.Join(s.Info().Directory, "after-disconnect"))
	if err != nil || string(data) != "detached" {
		t.Fatal("background job died without a page", string(data), err)
	}
	var replay uint64
	output = readUntil(t, s, &replay, "DETACHED_DONE")
	if !strings.Contains(output, "中文") || !strings.Contains(output, "READY") {
		t.Fatal("reconnect lost history", output)
	}
	if err := s.Write([]byte("printf '\\nFINAL_OUTPUT\\n'; exit 7\n")); err != nil {
		t.Fatal(err)
	}
	select {
	case <-s.done:
	case <-time.After(3 * time.Second):
		t.Fatal("exit leaked readers")
	}
	readUntil(t, s, &cursor, "FINAL_OUTPUT")
	if s.Info().Running || s.Info().ExitCode != 7 {
		t.Fatal("wrong exit", s.Info())
	}
	if same, err := m.Open("new", "workspace", s.Info().Directory, 80, 24); err != nil || same != s || same.Info().Running {
		t.Fatal("an exited shell restarted on read")
	}
}

func TestCloseCleansForegroundBackgroundAndAllowsExplicitRestart(t *testing.T) {
	m, s := testSession(t)
	if err := s.Write([]byte("sleep 60 & echo $! > background.pid; sleep 60 & echo $! > other.pid; wait\n")); err != nil {
		t.Fatal(err)
	}
	var pids []int
	for _, name := range []string{"background.pid", "other.pid"} {
		var raw []byte
		for until := time.Now().Add(3 * time.Second); time.Now().Before(until); {
			raw, _ = os.ReadFile(filepath.Join(s.Info().Directory, name))
			if len(raw) > 0 {
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
		pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
		if err != nil {
			t.Fatal("missing background process", err)
		}
		pids = append(pids, pid)
	}
	if err := m.CloseSession("workspace", "stale-id"); err == nil {
		t.Fatal("stale close accepted")
	}
	if err := m.CloseSession("workspace", "session"); err != nil {
		t.Fatal(err)
	}
	for _, pid := range pids {
		for until := time.Now().Add(time.Second); unix.Kill(pid, 0) == nil; {
			if time.Now().After(until) {
				t.Fatalf("background process %d survived close", pid)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	if err := s.Write([]byte("late")); err == nil {
		t.Fatal("write accepted after close")
	}
	next, err := m.Open("new", "workspace", s.Info().Directory, 80, 24)
	if err != nil || next == s {
		t.Fatal("explicit restart failed", err)
	}
	m.Close()
	if _, err := m.Open("later", "workspace", s.Info().Directory, 80, 24); err == nil {
		t.Fatal("opened after service shutdown")
	}
}

func TestBoundedByteHistoryAndExplicitEnvironment(t *testing.T) {
	s := &Session{history: make([]byte, HistoryLimit), changed: make(chan struct{})}
	source := bytes.Repeat([]byte("中文\x1b[31m\r\n"), HistoryLimit/6)
	for offset := 0; offset < len(source); offset += 71 {
		s.append(source[offset:min(offset+71, len(source))])
	}
	var actual []byte
	var cursor uint64
	truncation := false
	for {
		data, _, end, truncated, _, _ := s.Read(cursor)
		truncation = truncation || truncated
		cursor = end
		actual = append(actual, data...)
		if len(data) == 0 {
			break
		}
	}
	if !truncation || len(s.history) != HistoryLimit || !bytes.Equal(actual, source[len(source)-HistoryLimit:]) {
		t.Fatal("history was not bounded or bytes changed", len(actual))
	}
	t.Setenv("OPENAI_API_KEY", "never-inherit")
	t.Setenv("PITH_DESK_TOKEN", "never-inherit")
	t.Setenv("MCP_SECRET", "never-inherit")
	env := strings.Join(shellEnvironment("/bin/sh"), "\n")
	if strings.Contains(env, "never-inherit") || !strings.Contains(env, "TERM=xterm-256color") || !strings.Contains(env, "HOME=") {
		t.Fatal("unsafe shell environment", env)
	}
	for _, size := range [][2]int{{0, 24}, {80, 0}, {501, 24}, {80, 301}} {
		if ValidateSize(size[0], size[1]) == nil {
			t.Fatal("invalid size accepted", size)
		}
	}
}
