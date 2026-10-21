package host

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"time"

	"github.com/coder/websocket"
	"github.com/minifish-org/pith-desk/internal/terminal"
	"github.com/minifish-org/pith-desk/internal/wire"
)

func (s *Server) terminalDirectory(id string) (string, error) {
	return s.service.WorkspaceDirectory(id)
}
func (s *Server) terminalResponse(session *terminal.Session) wire.TerminalResponse {
	hostname, _ := os.Hostname()
	location := "Local computer"
	if s.access != nil {
		location = "Server"
	}
	if hostname != "" {
		location += " · " + hostname
	}
	response := wire.TerminalResponse{Location: location}
	if session != nil {
		info := session.Info()
		response.Session = &info
	}
	return response
}

func (s *Server) serveTerminal(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.Path != "/api/terminal" && r.URL.Path != "/api/terminal/close" {
		return false
	}
	if r.Method != http.MethodPost {
		s.fail(w, "Method not allowed", http.StatusMethodNotAllowed)
		return true
	}
	s.terminalMu.Lock()
	defer s.terminalMu.Unlock()
	var err error
	var session *terminal.Session
	decode := func(value any) error {
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
		decoder.DisallowUnknownFields()
		return decoder.Decode(value)
	}
	switch r.URL.Path {
	case "/api/terminal":
		var in wire.TerminalOpenInput
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
			var directory string
			if len(in.ID) > 128 {
				err = errors.New("Terminal ID is too long")
			} else if directory, err = s.terminalDirectory(in.WorkspaceID); err == nil {
				if in.ID == "" {
					in.ID = randomCredential()
				}
				session, err = s.terminals.Open(in.ID, in.WorkspaceID, directory, in.Cols, in.Rows)
			}
		}
	case "/api/terminal/close":
		var in wire.TerminalTarget
		if err = wire.Decode(r.URL.Path, decode, &in); err == nil {
			if in.ID == "" {
				err = errors.New("Terminal session ID is required")
			} else if _, err = s.terminalDirectory(in.WorkspaceID); err == nil {
				err = s.terminals.CloseSession(in.WorkspaceID, in.ID)
			}
		}
		if err == nil {
			wire.WriteJSON(w, r.Method, r.URL.Path, wire.OKResponse{OK: true})
			return true
		}
	default:
		s.fail(w, "Method not allowed", http.StatusMethodNotAllowed)
		return true
	}
	if err != nil {
		s.fail(w, err.Error(), http.StatusBadRequest)
	} else {
		wire.WriteJSON(w, r.Method, r.URL.Path, s.terminalResponse(session))
	}
	return true
}

func (s *Server) readTerminal(w http.ResponseWriter, r *http.Request) {
	query, err := wire.ReadQuery[wire.TerminalReadInput](r)
	if err == nil {
		_, err = s.terminalDirectory(query.WorkspaceID)
	}
	if err != nil {
		s.fail(w, err.Error(), http.StatusBadRequest)
		return
	}
	session, _ := s.terminals.Get(query.WorkspaceID, query.ID)
	response := s.terminalResponse(session)
	response.Sessions = s.terminals.List(query.WorkspaceID)
	wire.WriteJSON(w, r.Method, r.URL.Path, response)
}

// Recheck under the same handoff gate as HTTP mutations, at the moment an
// input/resize would reach the PTY. Queued frames from revoked pages cannot act.
func (s *Server) terminalControl(r *http.Request, session *terminal.Session, in wire.TerminalControl) error {
	s.operations.Lock()
	defer s.operations.Unlock()
	s.terminalMu.Lock()
	defer s.terminalMu.Unlock()
	if r.Context().Err() != nil || s.ctx.Err() != nil {
		return context.Canceled
	}
	if s.access != nil {
		s.access.mu.Lock()
		valid := s.access.leaseLocked(r) == r.Context().Value(leaseContextKey{})
		s.access.mu.Unlock()
		if !valid {
			return errors.New("Terminal control lease expired")
		}
	}
	if _, err := s.terminalDirectory(session.Info().WorkspaceID); err != nil {
		return err
	}
	switch in.Type {
	case "input":
		return session.Write([]byte(in.Data))
	case "resize":
		return session.Resize(in.Cols, in.Rows)
	default:
		return errors.New("Unknown terminal control")
	}
}

func (s *Server) terminalSocket(w http.ResponseWriter, r *http.Request) {
	query, err := wire.ReadQuery[wire.TerminalTarget](r)
	if err != nil {
		s.fail(w, err.Error(), 400)
		return
	}
	if _, err = s.terminalDirectory(query.WorkspaceID); err != nil {
		s.fail(w, err.Error(), 400)
		return
	}
	session, err := s.terminals.Get(query.WorkspaceID, query.ID)
	if err != nil || query.ID == "" {
		s.fail(w, "Terminal session is no longer available", 404)
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"pith-desk"}})
	if err != nil {
		return
	}
	defer conn.CloseNow()
	ctx, cancel := context.WithCancel(r.Context())
	stop := context.AfterFunc(s.ctx, cancel)
	defer stop()
	defer cancel()
	closeSocket := context.AfterFunc(ctx, func() { _ = conn.CloseNow() })
	defer closeSocket()
	conn.SetReadLimit(24 << 10)
	acks := make(chan uint64, 1)
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		defer cancel()
		for {
			kind, data, err := conn.Read(ctx)
			if err != nil {
				return
			}
			if kind != websocket.MessageText {
				return
			}
			var input wire.TerminalControl
			decoder := json.NewDecoder(bytes.NewReader(data))
			decoder.DisallowUnknownFields()
			if err := decoder.Decode(&input); err != nil {
				return
			}
			if input.Type == "ack" {
				select {
				case acks <- input.End:
				case <-ctx.Done():
					return
				}
			} else if err := s.terminalControl(r, session, input); err != nil {
				return
			}
		}
	}()
	defer func() { cancel(); _ = conn.CloseNow(); <-readerDone }()
	write := func(event wire.TerminalEvent) error {
		data, err := json.Marshal(event)
		if err != nil {
			return err
		}
		deadline, done := context.WithTimeout(ctx, 10*time.Second)
		defer done()
		return conn.Write(deadline, websocket.MessageText, data)
	}
	_, _, replayEnd, truncated, info, _ := session.Read(^uint64(0))
	// Read's clamp returns the current byte cursor without copying history.
	if err = write(wire.TerminalEvent{Type: "ready", Session: &info, End: replayEnd, Truncated: truncated}); err != nil {
		return
	}
	var cursor uint64
	live := false
	for {
		data, start, end, truncated, info, changed := session.Read(cursor)
		if len(data) > 0 {
			if err := write(wire.TerminalEvent{Type: "output", Data: base64.StdEncoding.EncodeToString(data), Start: start, End: end, Truncated: truncated}); err != nil {
				return
			}
			// Only one <=32 KiB frame may await xterm's parse callback. The
			// PTY reader keeps draining into its ring even if this page stalls.
			select {
			case ack := <-acks:
				if ack != end {
					return
				}
			case <-ctx.Done():
				return
			case <-time.After(30 * time.Second):
				return
			}
			cursor = end
		}
		if !live && cursor >= replayEnd {
			if err := write(wire.TerminalEvent{Type: "live"}); err != nil {
				return
			}
			live = true
		}
		if len(data) > 0 {
			continue
		}
		if !info.Running {
			_ = write(wire.TerminalEvent{Type: "exit", Session: &info})
			return
		}
		select {
		case <-changed:
		case <-ctx.Done():
			return
		}
	}
}
