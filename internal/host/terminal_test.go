package host

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/minifish-org/pith-desk/internal/testsupport/shellfixture"
	"github.com/minifish-org/pith-desk/internal/wire"
)

func openTestTerminal(t *testing.T, b *serverBrowser, workspace string) wire.TerminalResponse {
	t.Helper()
	resp, data := b.request(t, "POST", "/api/terminal", wire.TerminalOpenInput{WorkspaceID: workspace, Cols: 80, Rows: 24}, "")
	var result wire.TerminalResponse
	if resp.StatusCode != 200 || json.Unmarshal(data, &result) != nil || result.Session == nil {
		t.Fatalf("terminal open: %d %s", resp.StatusCode, data)
	}
	return result
}
func dialTestTerminal(t *testing.T, b *serverBrowser, target wire.TerminalTarget) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, strings.Replace(b.s.URL, "http:", "ws:", 1)+"/api/terminal/socket?workspaceId="+url.QueryEscape(target.WorkspaceID)+"&id="+url.QueryEscape(target.ID), &websocket.DialOptions{Subprotocols: []string{"pith-desk", "lease." + b.lease}, HTTPHeader: http.Header{"Origin": []string{b.s.URL}, "Cookie": []string{sessionCookie + "=" + b.cookie.Value}}})
	if err != nil {
		t.Fatal(err)
	}
	conn.SetReadLimit(64 << 10)
	t.Cleanup(func() { _ = conn.CloseNow() })
	return conn
}
func terminalSend(t *testing.T, conn *websocket.Conn, control wire.TerminalControl) {
	t.Helper()
	data, _ := json.Marshal(control)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
		t.Fatal(err)
	}
}
func terminalRead(t *testing.T, conn *websocket.Conn, until string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var output strings.Builder
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read %q: %v (%q)", until, err, output.String())
		}
		var event wire.TerminalEvent
		if err = json.Unmarshal(data, &event); err != nil {
			t.Fatal(err)
		}
		if event.Type == "output" {
			raw, err := base64.StdEncoding.DecodeString(event.Data)
			if err != nil {
				t.Fatal(err)
			}
			output.Write(raw)
			terminalSend(t, conn, wire.TerminalControl{Type: "ack", End: event.End})
		}
		if event.Type == until || strings.Contains(output.String(), until) {
			return output.String()
		}
	}
}

func TestTerminalAuthenticatedReconnectTakeoverAndLateControls(t *testing.T) {
	shell, err := shellfixture.Create(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("SHELL", shell)
	s := testServerMode(t, "")
	workspace, err := s.service.AddWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	b := &serverBrowser{s: s}
	b.login(t)
	b.acquire(t, "", false)
	opened := openTestTerminal(t, b, workspace.ID)
	target := wire.TerminalTarget{WorkspaceID: workspace.ID, ID: opened.Session.ID}
	conn := dialTestTerminal(t, b, target)
	terminalRead(t, conn, "live")
	terminalSend(t, conn, wire.TerminalControl{Type: "input", Data: "stty -echo; printf '\\nWS_READY_%s\\n' ok\n"})
	terminalRead(t, conn, "WS_READY_ok")
	terminalSend(t, conn, wire.TerminalControl{Type: "resize", Cols: 91, Rows: 33})
	terminalSend(t, conn, wire.TerminalControl{Type: "input", Data: "stty size; (sleep .15; printf closed-page > detached.txt; printf '\\nAFTER_PAGE_CLOSE\\n') &\n"})
	_ = conn.CloseNow()
	for deadline := time.Now().Add(3 * time.Second); ; {
		data, _ := os.ReadFile(filepath.Join(workspace.Path, "detached.txt"))
		if string(data) == "closed-page" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("page close killed terminal")
		}
		time.Sleep(20 * time.Millisecond)
	}
	// Actual refresh rotates the lease, but never recreates the terminal.
	oldLease := s.access.lease
	b.acquire(t, b.lease, false)
	again := openTestTerminal(t, b, workspace.ID)
	if again.Session.ID != target.ID {
		t.Fatal("refresh recreated the shell")
	}
	reconnected := dialTestTerminal(t, b, target)
	output := terminalRead(t, reconnected, "live")
	if !strings.Contains(output, "AFTER_PAGE_CLOSE") || !strings.Contains(output, "33 91") {
		t.Fatal("missing replay or size", output)
	}
	session, _ := s.terminals.Get(workspace.ID, target.ID)
	other := &serverBrowser{s: s}
	other.login(t)
	other.acquire(t, "", true)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, _, err := reconnected.Read(ctx); err == nil {
		t.Fatal("revoked terminal socket survived")
	}
	request, _ := http.NewRequest("GET", s.URL+"/api/terminal/socket", nil)
	request.AddCookie(b.cookie)
	request.Header.Set("X-Desk-Lease", oldLease.id)
	request = request.WithContext(context.WithValue(context.Background(), leaseContextKey{}, oldLease))
	for _, control := range []wire.TerminalControl{{Type: "input", Data: "touch late-input\n"}, {Type: "resize", Cols: 7, Rows: 2}} {
		if err := s.terminalControl(request, session, control); err == nil {
			t.Fatal("late control admitted", control)
		}
	}
	if _, err := os.Stat(filepath.Join(workspace.Path, "late-input")); err == nil {
		t.Fatal("late input reached shell")
	}
	if size := session.Info(); size.Cols != 91 || size.Rows != 33 {
		t.Fatal("late resize reached shell", size)
	}
	resp, data := b.request(t, "POST", "/api/terminal/close", target, "")
	if resp.StatusCode != 409 {
		t.Fatal("old page closed terminal", resp.StatusCode, string(data))
	}
	resp, data = other.request(t, "POST", "/api/terminal/close", target, "")
	if resp.StatusCode != 200 {
		t.Fatal("new page cannot close terminal", resp.StatusCode, string(data))
	}
	if session.Info().Running {
		t.Fatal("terminal still running after close")
	}
}

func TestTerminalFlowControlBoundedReplayWorkspaceRemovalAndShutdown(t *testing.T) {
	shell, err := shellfixture.Create(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("SHELL", shell)
	s := testServerMode(t, "")
	b := &serverBrowser{s: s}
	b.login(t)
	b.acquire(t, "", false)
	workspace, err := s.service.AddWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	other, err := s.service.AddWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	opened := openTestTerminal(t, b, workspace.ID)
	second := openTestTerminal(t, b, other.ID)
	if second.Session.ID == opened.Session.ID {
		t.Fatal("workspace session identity shared")
	}
	session, _ := s.terminals.Get(workspace.ID, opened.Session.ID)
	if err := session.Write([]byte("stty -echo; head -c 2097152 /dev/zero | tr '\\000' x; printf '\\nBOUNDED_DONE\\n'\n")); err != nil {
		t.Fatal(err)
	}
	for deadline := time.Now().Add(5 * time.Second); ; {
		data, _, _, truncated, _, _ := session.Read(0)
		if truncated && len(data) > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("history never wrapped")
		}
		time.Sleep(10 * time.Millisecond)
	}
	conn := dialTestTerminal(t, b, wire.TerminalTarget{WorkspaceID: workspace.ID, ID: opened.Session.ID})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, _, err = conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	} // ready
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var event wire.TerminalEvent
	_ = json.Unmarshal(data, &event)
	if event.Type != "output" || !event.Truncated || event.End-event.Start > 32<<10 {
		t.Fatal("unbounded frame or missing truncation", event.Type, event.Truncated, event.End-event.Start)
	}
	// Withhold the parse ACK: no additional output may enter browser buffers.
	blocked := make(chan error, 1)
	go func() { _, _, err := conn.Read(context.Background()); blocked <- err }()
	select {
	case err := <-blocked:
		t.Fatal("output sent without ACK", err)
	case <-time.After(80 * time.Millisecond):
	}
	_ = conn.CloseNow()
	<-blocked
	resp, data := b.request(t, "POST", "/api/remove-workspace", map[string]any{"id": workspace.ID, "conversationCount": 0}, "")
	if resp.StatusCode != 200 {
		t.Fatal("remove workspace", resp.StatusCode, string(data))
	}
	if session.Info().Running {
		t.Fatal("removed workspace retained shell")
	}
	remaining, _ := s.terminals.Get(other.ID, second.Session.ID)
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if remaining.Info().Running {
		t.Fatal("service shutdown retained shell")
	}
}
