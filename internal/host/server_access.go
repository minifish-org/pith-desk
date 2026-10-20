package host

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/minifish-org/pith-desk/internal/wire"
)

const leaseTTL = 45 * time.Second
const sessionTTL = 24 * time.Hour
const sessionCookie = "pith_desk_session"

type serverAccess struct {
	mu          sync.Mutex
	tokenHash   [32]byte
	secure      bool
	sessions    map[string]time.Time
	lease       *browserLease
	loginWindow time.Time
	loginTries  int
	now         func() time.Time
}

type browserLease struct {
	id, session string
	expires     time.Time
	ctx         context.Context
	cancel      context.CancelFunc
	highest     uint64
	requests    map[uint64]*mutationReceipt
}

type leaseContextKey struct{}

func newServerAccess(token string, secure bool) *serverAccess {
	return &serverAccess{tokenHash: sha256.Sum256([]byte(token)), secure: secure, sessions: make(map[string]time.Time), now: time.Now}
}

func randomCredential() string {
	var value [32]byte
	if _, err := rand.Read(value[:]); err != nil {
		panic("generate server credential: " + err.Error())
	}
	return hex.EncodeToString(value[:])
}

func (a *serverAccess) expireLocked() {
	now := a.now()
	for id, expires := range a.sessions {
		if !now.Before(expires) {
			delete(a.sessions, id)
		}
	}
	if a.lease != nil && (!now.Before(a.lease.expires) || a.sessions[a.lease.session].IsZero()) {
		a.lease.cancel()
		a.lease = nil
	}
}

func (a *serverAccess) expire(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			a.mu.Lock()
			if a.lease != nil {
				a.lease.cancel()
			}
			a.mu.Unlock()
			return
		case <-ticker.C:
			a.mu.Lock()
			a.expireLocked()
			a.mu.Unlock()
		}
	}
}

func (a *serverAccess) sessionLocked(r *http.Request) string {
	a.expireLocked()
	cookie, err := r.Cookie(sessionCookie)
	if err == nil && !a.sessions[cookie.Value].IsZero() {
		return cookie.Value
	}
	return ""
}

func requestLeaseID(r *http.Request) string {
	if r.URL.Path == "/api/socket" {
		for _, protocol := range strings.Split(r.Header.Get("Sec-WebSocket-Protocol"), ",") {
			if value, ok := strings.CutPrefix(strings.TrimSpace(protocol), "lease."); ok {
				return value
			}
		}
	}
	return r.Header.Get("X-Desk-Lease")
}

func (a *serverAccess) leaseLocked(r *http.Request) *browserLease {
	session := a.sessionLocked(r)
	lease := a.lease
	if session == "" || lease == nil || lease.ctx.Err() != nil || session != lease.session || subtle.ConstantTimeCompare([]byte(requestLeaseID(r)), []byte(lease.id)) != 1 {
		return nil
	}
	return lease
}

func (s *Server) authorizeServer(w http.ResponseWriter, r *http.Request) bool {
	a := s.access
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.sessionLocked(r) == "" {
		s.fail(w, "Sign in to Pith Desk Server.", http.StatusUnauthorized)
		return false
	}
	lease := a.leaseLocked(r)
	if lease == nil {
		s.fail(w, "This page no longer controls Pith Desk. Reconnect or take over to continue.", http.StatusConflict)
		return false
	}
	*r = *r.WithContext(context.WithValue(r.Context(), leaseContextKey{}, lease))
	return true
}

// HMR carries source code, never application snapshots or business actions.
// Vite controls its subprotocol; require an authenticated session here.
func (s *Server) authorizeDevelopment(w http.ResponseWriter, r *http.Request) bool {
	a := s.access
	a.mu.Lock()
	defer a.mu.Unlock()
	session := a.sessionLocked(r)
	if session == "" {
		s.fail(w, "Sign in first.", http.StatusUnauthorized)
		return false
	}
	return true
}

// These are the only Server endpoints available before lease admission. They
// never expose application data. Cookies alone cannot call the business API.
func (s *Server) serveAccess(w http.ResponseWriter, r *http.Request) bool {
	if !strings.HasPrefix(r.URL.Path, "/api/server/") {
		return false
	}
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		s.fail(w, "Method not allowed", http.StatusMethodNotAllowed)
		return true
	}
	if r.Header.Get("Origin") != s.URL || strings.Split(r.Header.Get("Content-Type"), ";")[0] != "application/json" {
		s.fail(w, "Same-origin JSON requests are required.", http.StatusForbidden)
		return true
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		s.fail(w, "Invalid or oversized access request", http.StatusBadRequest)
		return true
	}
	decode := func(value any) error {
		decoder := json.NewDecoder(bytes.NewReader(body))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(value); err != nil {
			return err
		}
		var trailing any
		if err := decoder.Decode(&trailing); err != io.EOF {
			return http.ErrBodyNotAllowed
		}
		return nil
	}
	a := s.access
	a.mu.Lock()
	defer a.mu.Unlock()
	session := a.sessionLocked(r)
	switch r.URL.Path {
	case "/api/server/session":
		var in wire.EmptyInput
		if err := wire.Decode(r.URL.Path, decode, &in); err != nil {
			s.fail(w, "Invalid request", 400)
			break
		}
		wire.WriteJSON(w, r.Method, r.URL.Path, wire.ServerSessionResponse{Authenticated: session != ""})
	case "/api/server/login":
		var in wire.ServerLoginInput
		if err := wire.Decode(r.URL.Path, decode, &in); err != nil {
			s.fail(w, "Invalid login request", 400)
			break
		}
		if a.now().Sub(a.loginWindow) >= time.Minute {
			a.loginWindow, a.loginTries = a.now(), 0
		}
		if a.loginTries >= 10 {
			w.Header().Set("Retry-After", "60")
			s.fail(w, "Too many sign-in attempts. Try again in a minute.", http.StatusTooManyRequests)
			break
		}
		hash := sha256.Sum256([]byte(in.Token))
		if subtle.ConstantTimeCompare(hash[:], a.tokenHash[:]) != 1 {
			a.loginTries++
			s.fail(w, "Invalid server token.", http.StatusUnauthorized)
			break
		}
		if session == "" {
			if len(a.sessions) >= 64 {
				s.fail(w, "Too many browser sessions. Restart the server to clear them.", http.StatusTooManyRequests)
				break
			}
			session = randomCredential()
		}
		a.sessions[session] = a.now().Add(sessionTTL)
		http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: session, Path: "/", HttpOnly: true, Secure: a.secure, SameSite: http.SameSiteStrictMode, MaxAge: int(sessionTTL.Seconds())})
		wire.WriteJSON(w, r.Method, r.URL.Path, wire.OKResponse{OK: true})
	case "/api/server/lease":
		var in wire.ServerLeaseInput
		if err := wire.Decode(r.URL.Path, decode, &in); err != nil {
			s.fail(w, "Invalid lease request", 400)
			break
		}
		if session == "" {
			s.fail(w, "Sign in first.", http.StatusUnauthorized)
			break
		}
		if a.lease != nil && a.lease.ctx.Err() != nil {
			s.fail(w, "Control is changing. Reconnect after the handoff finishes.", http.StatusConflict)
			break
		}
		if a.lease != nil && !in.Takeover && !(a.lease.session == session && subtle.ConstantTimeCompare([]byte(in.Resume), []byte(a.lease.id)) == 1) {
			s.fail(w, "Another page controls Pith Desk. Take over to continue here.", http.StatusConflict)
			break
		}
		if a.lease != nil {
			a.lease.cancel()
		}
		// Revoke immediately, then finish already-running mutations before
		// issuing a new credential. Slow request bodies have not entered this
		// gate; canceled network probes release it through their request context.
		previous := a.lease
		a.mu.Unlock()
		s.operations.Lock()
		a.mu.Lock()
		defer s.operations.Unlock()
		if a.lease != previous || a.sessionLocked(r) == "" {
			s.fail(w, "Control changed while reconnecting. Try again.", http.StatusConflict)
			break
		}
		ctx, cancel := context.WithCancel(context.Background())
		a.lease = &browserLease{id: randomCredential(), session: session, expires: a.now().Add(leaseTTL), ctx: ctx, cancel: cancel, requests: make(map[uint64]*mutationReceipt)}
		wire.WriteJSON(w, r.Method, r.URL.Path, wire.ServerLeaseResponse{Lease: a.lease.id, ExpiresIn: int(leaseTTL.Seconds())})
	case "/api/server/heartbeat":
		var in wire.EmptyInput
		if err := wire.Decode(r.URL.Path, decode, &in); err != nil {
			s.fail(w, "Invalid heartbeat", 400)
			break
		}
		if session == "" {
			s.fail(w, "Sign in first.", http.StatusUnauthorized)
			break
		}
		if a.leaseLocked(r) == nil {
			s.fail(w, "This page no longer controls Pith Desk.", http.StatusConflict)
			break
		}
		a.lease.expires = a.now().Add(leaseTTL)
		wire.WriteJSON(w, r.Method, r.URL.Path, wire.OKResponse{OK: true})
	case "/api/server/logout":
		var in wire.EmptyInput
		if err := wire.Decode(r.URL.Path, decode, &in); err != nil {
			s.fail(w, "Invalid logout request", 400)
			break
		}
		if session == "" {
			s.fail(w, "Sign in first.", http.StatusUnauthorized)
			break
		}
		if a.leaseLocked(r) == nil {
			s.fail(w, "This page no longer controls Pith Desk.", http.StatusConflict)
			break
		}
		a.lease.cancel()
		a.lease = nil
		delete(a.sessions, session)
		http.SetCookie(w, &http.Cookie{Name: sessionCookie, Path: "/", HttpOnly: true, Secure: a.secure, SameSite: http.SameSiteStrictMode, MaxAge: -1})
		wire.WriteJSON(w, r.Method, r.URL.Path, wire.OKResponse{OK: true})
	default:
		s.fail(w, "Not found", http.StatusNotFound)
	}
	return true
}
