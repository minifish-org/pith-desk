package desk

import (
	"context"
	"encoding/json"
	"errors"
	"image/color"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/minifish-org/pith-desk/internal/testsupport/filefault"
	"github.com/minifish-org/pith/packages/durable"
	"github.com/minifish-org/pith/packages/durable/storage/jsonl"
)

type journalWindow struct {
	durable.Storage
	before  func(context.Context, []durable.StorageWrite) error
	after   func(context.Context, []durable.StorageWrite) error
	closing func(context.Context) error
}

func (s *journalWindow) Commit(ctx context.Context, writes []durable.StorageWrite) (durable.Seq, error) {
	if s.before != nil {
		if err := s.before(ctx, writes); err != nil {
			return 0, err
		}
	}
	seq, err := s.Storage.Commit(ctx, writes)
	if err == nil && s.after != nil {
		err = s.after(ctx, writes)
	}
	return seq, err
}
func (s *journalWindow) Close(ctx context.Context) error {
	if s.closing != nil {
		if err := s.closing(ctx); err != nil {
			return err
		}
	}
	return s.Storage.Close(ctx)
}
func journalHasKind(writes []durable.StorageWrite, kind string) bool {
	for _, write := range writes {
		if write.Entry != nil && write.Entry.Kind == kind {
			return true
		}
	}
	return false
}
func journalSettles(writes []durable.StorageWrite) bool {
	for _, write := range writes {
		if write.Task != nil && write.Task.State.Status == durable.TaskStatusTerminal {
			return true
		}
	}
	return false
}
func installJournalWindow(s *Service, before func(context.Context, []durable.StorageWrite) error, closing func(context.Context) error) {
	s.journals.open = func(path string) (durable.Storage, error) {
		base, err := jsonl.Open(context.Background(), path, jsonl.Options{Fsync: true})
		if err != nil {
			return nil, err
		}
		return &journalWindow{Storage: base, before: before, closing: closing}, nil
	}
}

func TestTaskAdmissionFailureNeverDispatchesToModel(t *testing.T) {
	var calls atomic.Int64
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		startSSE(w)
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": "fixture reply"}}}})
		finishSSE(w, "stop")
	}))
	t.Cleanup(provider.Close)
	s, _, dir := configuredService(t, provider.URL)
	installJournalWindow(s, func(_ context.Context, writes []durable.StorageWrite) error {
		for _, write := range writes {
			if write.Task != nil {
				return filefault.ErrInjected
			}
		}
		return nil
	}, nil)
	if err := s.Send("not admitted"); !errors.Is(err, filefault.ErrInjected) {
		t.Fatalf("admission error: %v", err)
	}
	state := s.Snapshot()
	if state.Running || len(state.Runs) != 0 || calls.Load() != 0 {
		t.Fatal("failed admission was dispatched")
	}
	s.Close()
	reopened, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	state = reopened.Snapshot()
	if state.Running || state.Runtime.Phase == "interrupted" || calls.Load() != 0 {
		t.Fatalf("uncommitted admission recovered as task: %+v", state)
	}
}

func TestQueueJournalFailuresKeepSDKAndDeskInputsCoordinated(t *testing.T) {
	for _, action := range []string{"add", "edit", "delete", "steer"} {
		t.Run(action, func(t *testing.T) {
			requests := make(chan map[string]any, 8)
			release := make(chan struct{})
			var once sync.Once
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				json.NewDecoder(r.Body).Decode(&body)
				requests <- body
				startSSE(w)
				w.(http.Flusher).Flush()
				select {
				case <-release:
				case <-r.Context().Done():
					return
				}
				sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": "fixture reply"}}}})
				finishSSE(w, "stop")
			}))
			t.Cleanup(provider.Close)
			t.Cleanup(func() { once.Do(func() { close(release) }) })
			s, _, _ := configuredService(t, provider.URL)
			var rejected atomic.Value
			rejected.Store("")
			installJournalWindow(s, func(_ context.Context, writes []durable.StorageWrite) error {
				kind := rejected.Load().(string)
				if kind != "" && journalHasKind(writes, kind) {
					// The SDK distinguishes a known pre-admission rejection from an
					// uncertain I/O failure, which poisons the journal until reopen.
					return &durable.StorageRejected{Message: "injected pre-admission rejection", Cause: filefault.ErrInjected}
				}
				return nil
			}, nil)
			id := s.Snapshot().ActiveID
			if err := s.Send("start"); err != nil {
				t.Fatal(err)
			}
			receiveProviderRequest(t, requests)
			image := imageFixture(t, color.RGBA{B: 255, A: 255})
			for _, text := range []string{"first pending", "second pending"} {
				if err := s.QueueMessage(id, text, "", image); err != nil {
					t.Fatal(err)
				}
			}
			before := s.Snapshot().QueuedMessages
			s.mu.Lock()
			dispatched := s.active.queueDispatched[before[0].ID]
			s.mu.Unlock()
			if !dispatched {
				t.Fatal("mutation did not cover SDK BeforeCommit")
			}
			kind := "desk.queue-update"
			if action == "add" {
				kind = "desk.queue"
			}
			if action == "delete" {
				kind = "desk.queue-delete"
			}
			rejected.Store(kind)
			var err error
			if action == "add" {
				err = s.QueueMessage(id, "uncommitted extra", "", image)
			} else {
				err = s.MutateQueuedMessage(id, before[0].ID, action, "uncommitted replacement")
			}
			if !errors.Is(err, filefault.ErrInjected) {
				t.Fatalf("journal failure hidden: %v", err)
			}
			if !reflect.DeepEqual(s.Snapshot().QueuedMessages, before) {
				t.Fatal("failed commit changed Desk input order/attachments")
			}
			rejected.Store("")
			once.Do(func() { close(release) })
			first := receiveProviderRequest(t, requests)
			if countProviderUser(first, "first pending") != 1 || countProviderUser(first, "second pending") != 0 || len(providerImageURLs(first)) != 1 {
				t.Fatalf("first SDK delivery changed: %v", first["messages"])
			}
			next := receiveProviderRequest(t, requests)
			if countProviderUser(next, "first pending") != 1 || countProviderUser(next, "second pending") != 1 || countProviderUser(next, "uncommitted extra") != 0 || countProviderUser(next, "uncommitted replacement") != 0 || len(providerImageURLs(next)) != 2 {
				t.Fatalf("failed commit changed SDK input/attachments: %v", next["messages"])
			}
			waitState(t, s, func(st State) bool { return !st.Running })
		})
	}
}

func TestUncertainQueueWriteFailureClosesJournalAndPreservesRecovery(t *testing.T) {
	requests := make(chan map[string]any, 8)
	release := make(chan struct{})
	var once sync.Once
	var calls atomic.Int64
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		calls.Add(1)
		requests <- body
		startSSE(w)
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": "fixture reply"}}}})
		finishSSE(w, "stop")
	}))
	t.Cleanup(provider.Close)
	s, _, dir := configuredService(t, provider.URL)
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	var reject atomic.Bool
	installJournalWindow(s, func(_ context.Context, writes []durable.StorageWrite) error {
		if reject.Load() && journalHasKind(writes, "desk.queue-update") {
			return filefault.ErrInjected // uncertain I/O, not StorageRejected
		}
		return nil
	}, nil)
	id := s.Snapshot().ActiveID
	if err := s.Send("start"); err != nil {
		t.Fatal(err)
	}
	receiveProviderRequest(t, requests)
	image := imageFixture(t, color.RGBA{R: 255, A: 255})
	if err := s.QueueMessage(id, "recover uncertain input", "", image); err != nil {
		t.Fatal(err)
	}
	before := s.Snapshot().QueuedMessages
	reject.Store(true)
	if err := s.MutateQueuedMessage(id, before[0].ID, "edit", "uncommitted replacement"); !errors.Is(err, filefault.ErrInjected) {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(s.Snapshot().QueuedMessages, before) {
		t.Fatal("uncertain rejection changed pending input")
	}
	once.Do(func() { close(release) })
	next := receiveProviderRequest(t, requests)
	if countProviderUser(next, "recover uncertain input") != 1 || countProviderUser(next, "uncommitted replacement") != 0 || len(providerImageURLs(next)) != 1 {
		t.Fatal("failed BeforeCommit changed SDK input")
	}
	state := waitState(t, s, func(st State) bool { return !st.Running })
	if !strings.Contains(state.Error, "injected") || state.Runtime.Phase != "error" || state.Conversations[0].Unread || state.Conversations[0].CompletedRunID != "" {
		t.Fatalf("poisoned journal announced completion: %+v", state)
	}
	s.Close()
	count := calls.Load()
	reopened, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	state = reopened.Snapshot()
	if state.Running || state.Failure == nil || state.Failure.Kind != "interrupted" || !reflect.DeepEqual(state.QueuedMessages, before) || calls.Load() != count {
		t.Fatal("uncertain input was lost or automatically replayed")
	}
}

func TestDeliveredMarkerFailureRestoresUncertainInputWithoutAutomaticReplay(t *testing.T) {
	requests := make(chan map[string]any, 8)
	firstRelease := make(chan struct{})
	var releaseOnce sync.Once
	var calls atomic.Int64
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		requests <- body
		startSSE(w)
		w.(http.Flusher).Flush()
		if calls.Add(1) == 1 {
			select {
			case <-firstRelease:
			case <-r.Context().Done():
				return
			}
			sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": "fixture reply"}}}})
			finishSSE(w, "stop")
			return
		}
		<-r.Context().Done()
	}))
	t.Cleanup(provider.Close)
	defer releaseOnce.Do(func() { close(firstRelease) })
	s, _, dir := configuredService(t, provider.URL)
	var reject atomic.Bool
	reject.Store(true)
	installJournalWindow(s, func(_ context.Context, writes []durable.StorageWrite) error {
		if journalHasKind(writes, "desk.delivered") && reject.Load() {
			return filefault.ErrInjected
		}
		return nil
	}, nil)
	id := s.Snapshot().ActiveID
	if err := s.Send("start"); err != nil {
		t.Fatal(err)
	}
	receiveProviderRequest(t, requests)
	if err := s.QueueMessage(id, "uncertain delivery", ""); err != nil {
		t.Fatal(err)
	}
	releaseOnce.Do(func() { close(firstRelease) })
	receiveProviderRequest(t, requests)
	state := waitState(t, s, func(st State) bool { return len(st.QueuedMessages) == 0 && strings.Contains(st.Error, "injected") })
	if countText(state.Messages, "uncertain delivery") != 1 {
		t.Fatal("SDK did not consume input before marker failure")
	}
	s.Close()
	before := calls.Load()
	reopened, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	state = reopened.Snapshot()
	if state.Running || state.Failure == nil || state.Failure.Kind != "interrupted" || len(state.QueuedMessages) != 1 || state.QueuedMessages[0].Text != "uncertain delivery" || calls.Load() != before {
		t.Fatalf("unsafe recovery: %+v", state)
	}
}

func TestSettlementFailureDoesNotPublishCompletionAndRemainsRecoverable(t *testing.T) {
	var calls atomic.Int64
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		startSSE(w)
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": "fixture reply"}}}})
		finishSSE(w, "stop")
	}))
	t.Cleanup(provider.Close)
	s, _, dir := configuredService(t, provider.URL)
	var reject atomic.Bool
	reject.Store(true)
	closing, releaseClose := make(chan struct{}), make(chan struct{})
	var closeOnce, releaseOnce sync.Once
	t.Cleanup(func() { releaseOnce.Do(func() { close(releaseClose) }) })
	installJournalWindow(s, func(_ context.Context, writes []durable.StorageWrite) error {
		if journalSettles(writes) && reject.CompareAndSwap(true, false) {
			return filefault.ErrInjected
		}
		return nil
	}, func(context.Context) error {
		closeOnce.Do(func() { close(closing) })
		<-releaseClose
		return nil
	})
	if err := s.Send("finish model but fail settlement"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-closing:
	case <-time.After(10 * time.Second):
		t.Fatal("settlement error did not start resource cleanup")
	}
	if st := s.Snapshot(); !st.Running || st.Conversations[0].Unread || st.Conversations[0].CompletedRunID != "" {
		t.Fatal("failed settlement released occupancy before cleanup")
	}
	if err := s.Send("overlap while failure closes"); err == nil {
		t.Fatal("failed settlement released workspace early")
	}
	releaseOnce.Do(func() { close(releaseClose) })
	state := waitState(t, s, func(st State) bool { return !st.Running })
	if state.Conversations[0].Unread || state.Conversations[0].CompletedRunID != "" || !strings.Contains(state.Error, "injected") || state.Runtime.Phase != "error" || state.Failure == nil || !state.Failure.CanContinue {
		t.Fatalf("failed settlement announced success: %+v", state)
	}
	s.Close()
	before := calls.Load()
	reopened, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	state = reopened.Snapshot()
	if state.Running || state.Conversations[0].Unread || calls.Load() != before || state.Failure == nil || state.Failure.Kind != "interrupted" {
		t.Fatal("settlement failure automatically replayed or notified")
	}
	if err := reopened.ContinueTask(state.ActiveID); err != nil {
		t.Fatal(err)
	}
	waitState(t, reopened, func(st State) bool { return !st.Running && st.Runtime.Phase == "complete" })
	if calls.Load() != before+1 {
		t.Fatal("reviewed continuation replayed old model requests")
	}
}

func TestContinueQueueFailurePreservesAllInputAndAdmission(t *testing.T) {
	requests := make(chan map[string]any, 8)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		requests <- body
		startSSE(w)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	t.Cleanup(provider.Close)
	s, _, dir := configuredService(t, provider.URL)
	id := s.Snapshot().ActiveID
	if err := s.Send("interrupted original"); err != nil {
		t.Fatal(err)
	}
	receiveProviderRequest(t, requests)
	image := imageFixture(t, color.RGBA{B: 255, A: 255})
	for _, text := range []string{"recover first", "recover second"} {
		if err := s.QueueMessage(id, text, "", image); err != nil {
			t.Fatal(err)
		}
	}
	s.Close()
	reopened, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	original := reopened.Snapshot()
	var queues atomic.Int64
	installJournalWindow(reopened, func(_ context.Context, writes []durable.StorageWrite) error {
		for _, write := range writes {
			if write.Entry != nil && write.Entry.Kind == "desk.queue" && queues.Add(1) == 2 {
				return filefault.ErrInjected
			}
		}
		return nil
	}, nil)
	if err := reopened.ContinueTask(id); !errors.Is(err, filefault.ErrInjected) {
		t.Fatalf("continue failure: %v", err)
	}
	state := reopened.Snapshot()
	if state.Running || state.Runtime.RunID != original.Runtime.RunID || !reflect.DeepEqual(state.QueuedMessages, original.QueuedMessages) || state.Failure == nil || state.Failure.Kind != "interrupted" {
		t.Fatalf("failed admission erased recovered input: %+v", state)
	}
	select {
	case <-requests:
		t.Fatal("failed Continue dispatched to the model")
	default:
	}
	reopened.Close()
	again, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	state = again.Snapshot()
	if !reflect.DeepEqual(state.QueuedMessages, original.QueuedMessages) || state.Runtime.RunID != original.Runtime.RunID || state.Running {
		t.Fatalf("restart lost uncommitted remainder: %+v", state)
	}
	if err := again.ContinueTask(id); err != nil {
		t.Fatal(err)
	}
	if again.Snapshot().Runtime.RunID == original.Runtime.RunID || len(again.Snapshot().QueuedMessages) != 2 {
		t.Fatal("retry failed to admit both recovered inputs")
	}
	if countProviderUser(receiveProviderRequest(t, requests), "interrupted original") != 1 {
		t.Fatal("retry lost canonical history")
	}
}

func TestSettlementAndCloseHoldWorkspaceUntilAllResourcesRelease(t *testing.T) {
	requests := make(chan map[string]any, 8)
	finishA := make(chan struct{})
	canceledB := make(chan struct{})
	var finishOnce, cancelOnce sync.Once
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		requests <- body
		startSSE(w)
		w.(http.Flusher).Flush()
		if countProviderUser(body, "Task A") == 1 {
			select {
			case <-finishA:
			case <-r.Context().Done():
				return
			}
			sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": "fixture reply"}}}})
			finishSSE(w, "stop")
		} else {
			<-r.Context().Done()
			cancelOnce.Do(func() { close(canceledB) })
		}
	}))
	t.Cleanup(provider.Close)
	t.Cleanup(func() { finishOnce.Do(func() { close(finishA) }) })
	s, workspaceA, dir := configuredService(t, provider.URL)
	idA := s.Snapshot().ActiveID
	settling, releaseSettlement := make(chan struct{}), make(chan struct{})
	closing, releaseClose := make(chan struct{}), make(chan struct{})
	var settleOnce, closeOnce sync.Once
	t.Cleanup(func() {
		select {
		case <-releaseSettlement:
		default:
			close(releaseSettlement)
		}
		select {
		case <-releaseClose:
		default:
			close(releaseClose)
		}
	})
	s.journals.open = func(path string) (durable.Storage, error) {
		base, err := jsonl.Open(context.Background(), path, jsonl.Options{Fsync: true})
		if err != nil {
			return nil, err
		}
		probe := &journalWindow{Storage: base}
		if strings.HasSuffix(path, idA) {
			probe.before = func(ctx context.Context, writes []durable.StorageWrite) error {
				if journalSettles(writes) {
					settleOnce.Do(func() { close(settling) })
					<-releaseSettlement
				}
				return nil
			}
			probe.closing = func(ctx context.Context) error { closeOnce.Do(func() { close(closing) }); <-releaseClose; return nil }
		}
		return probe, nil
	}
	if err := s.Send("Task A"); err != nil {
		t.Fatal(err)
	}
	receiveProviderRequest(t, requests)
	_, b := addTestConversation(t, s, t.TempDir())
	if err := s.Send("Task B"); err != nil {
		t.Fatal(err)
	}
	receiveProviderRequest(t, requests)
	finishOnce.Do(func() { close(finishA) })
	select {
	case <-settling:
	case <-time.After(10 * time.Second):
		t.Fatal("settlement did not block")
	}
	if err := s.OpenConversation(idA); err != nil {
		t.Fatal(err)
	}
	state := s.Snapshot()
	if !state.Running || len(state.Runs) != 2 || state.Conversations[0].Unread {
		t.Fatal("AgentEnd released occupancy or published completion")
	}
	if err := s.Send("overlap"); err == nil {
		t.Fatal("settlement released workspace")
	}
	if err := s.DeleteConversation(idA); err == nil {
		t.Fatal("settling data was deleted")
	}
	overlap, err := s.AddWorkspace(workspaceA)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.RemoveWorkspace(overlap.ID, 1); err == nil {
		t.Fatal("settling workspace was removed")
	}
	close(releaseSettlement)
	select {
	case <-closing:
	case <-time.After(10 * time.Second):
		t.Fatal("resource close did not block")
	}
	state = s.Snapshot()
	if !state.Running || state.Conversations[0].Unread {
		t.Fatal("resource cleanup released task too early")
	}
	doneA, doneB := make(chan struct{}), make(chan struct{})
	go func() { s.Close(); close(doneA) }()
	go func() { s.Close(); close(doneB) }()
	abortDone := make(chan struct{})
	go func() { _ = s.AbortConversation(idA); close(abortDone) }()
	select {
	case <-canceledB:
	case <-time.After(10 * time.Second):
		t.Fatal("blocked A prevented canceling B")
	}
	if second, err := New(dir); err == nil {
		second.Close()
		t.Fatal("close released data lock before resources")
	}
	select {
	case <-doneA:
		t.Fatal("close returned before resources")
	default:
	}
	close(releaseClose)
	for _, done := range []chan struct{}{doneA, doneB, abortDone} {
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Fatal("concurrent close/abort deadlocked")
		}
	}
	reopened, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	reopened.Close()
	_ = b
}
