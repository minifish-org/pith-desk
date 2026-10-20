package host

import (
	"bytes"
	"crypto/sha256"
	"io"
	"net/http"
	"strconv"
)

// Each page sends monotonic operation numbers. Keep a small response window;
// older numbers are rejected, never executed again, even after eviction. A
// refreshed page receives a new lease and only reads actual service state.
type mutationReceipt struct {
	hash   [32]byte
	done   chan struct{}
	status int
	header http.Header
	body   []byte
}

// Buffer the small command response so a slow/disconnected browser cannot
// hold the mutation handoff gate while writing its response to the network.
type mutationResponse struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func (w *mutationResponse) Header() http.Header { return w.header }
func (w *mutationResponse) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
}
func (w *mutationResponse) Write(data []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	return w.body.Write(data)
}

func (s *Server) serverMutation(w http.ResponseWriter, r *http.Request) {
	number, err := strconv.ParseUint(r.Header.Get("X-Desk-Request"), 10, 53)
	if err != nil || number == 0 {
		s.fail(w, "A page operation number is required.", http.StatusBadRequest)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, requestBodyLimit(r.URL.Path)))
	if err != nil {
		s.fail(w, "Invalid or oversized request body.", http.StatusRequestEntityTooLarge)
		return
	}
	hasher := sha256.New()
	hasher.Write([]byte(r.URL.RequestURI()))
	hasher.Write([]byte{0})
	hasher.Write(body)
	var hash [32]byte
	copy(hash[:], hasher.Sum(nil))
	a := s.access
	a.mu.Lock()
	// Check again after receiving uploads: takeover during a slow upload must
	// not admit an operation from the page that has lost its lease.
	lease := a.leaseLocked(r)
	if lease == nil {
		a.mu.Unlock()
		s.fail(w, "This page no longer controls Pith Desk.", http.StatusConflict)
		return
	}
	if previous := lease.requests[number]; previous != nil {
		a.mu.Unlock()
		if previous.hash != hash {
			s.fail(w, "This operation number was already used for a different request.", http.StatusConflict)
			return
		}
		select {
		case <-previous.done:
			if previous.body == nil {
				s.fail(w, "This operation was already admitted. Refresh to read its current state.", http.StatusConflict)
				return
			}
			for key, values := range previous.header {
				w.Header()[key] = values
			}
			w.WriteHeader(previous.status)
			_, _ = w.Write(previous.body)
		case <-r.Context().Done():
		}
		return
	}
	if lease.highest >= 64 && number <= lease.highest-64 {
		a.mu.Unlock()
		s.fail(w, "This operation number has expired. Refresh to read current state.", http.StatusConflict)
		return
	}
	if number > lease.highest {
		lease.highest = number
	}
	for id, receipt := range lease.requests {
		if lease.highest >= 64 && id <= lease.highest-64 {
			select {
			case <-receipt.done:
				delete(lease.requests, id)
			default:
			}
		}
	}
	if len(lease.requests) >= 128 {
		a.mu.Unlock()
		s.fail(w, "Too many pending operations.", http.StatusTooManyRequests)
		return
	}
	receipt := &mutationReceipt{hash: hash, done: make(chan struct{})}
	lease.requests[number] = receipt
	a.mu.Unlock()
	defer close(receipt.done)
	r.Body = io.NopCloser(bytes.NewReader(body))
	response := &mutationResponse{header: w.Header().Clone()}
	func() {
		s.operations.Lock()
		defer s.operations.Unlock()
		a.mu.Lock()
		current := a.leaseLocked(r) == lease
		a.mu.Unlock()
		if current {
			s.serveAPI(response, r)
		} else {
			s.fail(response, "This page no longer controls Pith Desk.", http.StatusConflict)
		}
	}()
	receipt.status, receipt.header = response.status, response.header.Clone()
	if response.body.Len() <= 2<<20 {
		receipt.body = response.body.Bytes()
	}
	for key, values := range response.header {
		w.Header()[key] = values
	}
	w.WriteHeader(response.status)
	_, _ = w.Write(response.body.Bytes())
}
