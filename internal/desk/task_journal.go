package desk

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	aitypes "github.com/minifish-org/pith/packages/ai/types"
	"github.com/minifish-org/pith/packages/durable"
	dh "github.com/minifish-org/pith/packages/durable/harness"
	"github.com/minifish-org/pith/packages/durable/storage/jsonl"
)

// The Durable harness owns admission, checkpoints, task settlement and JSONL
// crash recovery. AgentSession continues to own chat branches and execution.
// An interrupted envelope is never blindly replayed: its tools can have OS or
// remote side effects. Continue uses the saved transcript and a new instruction.
type deskDurable struct {
	harness      *dh.Harness
	storage      durable.Storage
	conversation durable.ConversationID
	task         durable.TaskID
	wait         context.Context
}

type durableInput struct {
	RunID         string                 `json:"runId"`
	Text          string                 `json:"text"`
	Images        []aitypes.ImageContent `json:"images,omitempty"`
	Compact       bool                   `json:"compact"`
	EditMessageID string                 `json:"editMessageId,omitempty"`
	// Nil identifies old journals. Empty identifies a newly empty transcript.
	// Use the last stored entry, not the selected branch's possibly older leaf.
	AfterEntryID *string `json:"afterEntryId,omitempty"`
}

type TaskJournal struct {
	dataDir string
	open    func(string) (durable.Storage, error)
}

func (j *TaskJournal) dir(id string) string    { return filepath.Join(j.dataDir, "durable", id) }
func (s *Service) durableDir(id string) string { return s.journals.dir(id) }

func (r *RunExecution) admitDurableLocked(id string, workspace Workspace, config savedConfig, model *aitypes.Model, input durableInput) (*deskDurable, error) {
	return r.admitDurableWithQueueLocked(id, workspace, config, model, input, nil)
}

func (r *RunExecution) admitDurableWithQueueLocked(id string, workspace Workspace, config savedConfig, model *aitypes.Model, input durableInput, pending []QueuedMessage) (*deskDurable, error) {
	s := r.dependencies
	if !input.Compact {
		manager, err := (SessionAdapter{dataDir: s.dataDir}).read(id)
		if err != nil {
			return nil, err
		}
		last := ""
		if manager != nil {
			entries := manager.Entries()
			if len(entries) > 0 {
				last = entries[len(entries)-1].ID
			}
			_ = manager.Close()
		}
		input.AfterEntryID = &last
	}
	path := s.journals.dir(id)
	if err := os.MkdirAll(path, 0700); err != nil {
		return nil, err
	}
	storage, err := s.journals.openStorage(path)
	if err != nil {
		return nil, err
	}
	registry := dh.CreateRegistry()
	definition := durable.DefineTask(durable.TaskDefinition{
		Name: "desk.agent-session", Version: 1,
		Initial: func(json.RawMessage) (json.RawMessage, error) { return json.RawMessage(`{"phase":"execute"}`), nil },
		Phases:  map[string]durable.PhaseHandler{},
	})
	settle := func(ctx context.Context, runtime durable.TaskRuntime, status, reason string) error {
		return runtime.Commit(ctx, func(_ durable.Tx, task *durable.TaskRecord) error {
			task.State = durable.TaskState{Status: durable.TaskStatusTerminal, Outcome: &durable.TaskOutcome{Status: status, Reason: reason}}
			return nil
		})
	}
	definition.Phases["execute"] = func(ctx context.Context, record durable.TaskRecord, runtime durable.TaskRuntime) error {
		if record.ID != r.durableTaskID() {
			// Historical in-flight tasks are settled as interrupted before the
			// new reviewed task can execute. Never invoke their saved prompt.
			return settle(ctx, runtime, durable.OutcomeFailed, "Interrupted; review before continuing")
		}
		memo, err := runtime.Memo(ctx, "execution-admitted", nil)
		if err != nil {
			return err
		}
		if memo != nil {
			return settle(ctx, runtime, durable.OutcomeFailed, "Interrupted execution is not replay-safe")
		}
		if _, err = runtime.Memo(ctx, "execution-admitted", json.RawMessage(`true`)); err != nil {
			return err
		}
		r.run(ctx, id, workspace, config, model, input.Text, input.Images, input.Compact, input.EditMessageID)
		s.mu.Lock()
		phase := r.Runtime.Phase
		closed := *s.closed
		s.mu.Unlock()
		if closed || ctx.Err() != nil {
			return ctx.Err()
		}
		status := durable.OutcomeCompleted
		if phase == "error" || phase == "stopped" {
			status = durable.OutcomeFailed
		}
		return settle(ctx, runtime, status, phase)
	}
	definition.Abort = func(ctx context.Context, _ durable.TaskRecord, runtime durable.TaskRuntime) error {
		return settle(ctx, runtime, durable.OutcomeAborted, "Stopped by user")
	}
	if err = registry.Install(dh.Extension{Name: "desk", Tasks: []durable.TaskDefinition{definition}}); err != nil {
		_ = storage.Close(context.Background())
		return nil, err
	}
	// The SDK reports scheduler/storage failures separately from WaitForTask.
	// Wake this execution's waiter so it can close the harness before releasing
	// occupancy. A report never cancels another conversation's execution.
	wait, report := context.WithCancelCause(context.Background())
	harness, err := dh.Open(context.Background(), storage, dh.Options{Registry: registry, OnReport: func(err error) {
		// Abort replaces the running phase with the SDK's abort handler. Its
		// canceled phase must finish that settlement instead of closing early.
		if !errors.Is(err, context.Canceled) {
			report(err)
		}
	}})
	if err != nil {
		_ = storage.Close(context.Background())
		return nil, err
	}
	conversation, err := harness.Root(context.Background(), dh.RootOptions{})
	if err != nil {
		_ = harness.Close(context.Background())
		return nil, err
	}
	journal := &deskDurable{harness: harness, storage: storage, conversation: conversation.ID(), wait: wait}
	encoded, err := json.Marshal(input)
	if err == nil {
		err = harness.CommitConversation(context.Background(), conversation.ID(), func(tx *durable.Transaction) error {
			if _, err := tx.AppendEntry(context.Background(), conversation.ID(), durable.EntryDraft{Kind: "desk.clear-queue", Data: json.RawMessage(`{}`)}); err != nil {
				return err
			}
			// Reviewed continuation replaces the queue and admits the new task in
			// one transaction. A failure cannot erase the uncommitted remainder.
			for _, message := range pending {
				payload, err := queuePayload(message)
				if err != nil {
					return err
				}
				if _, err := tx.AppendEntry(context.Background(), conversation.ID(), durable.EntryDraft{Kind: "desk.queue", Data: payload}); err != nil {
					return err
				}
			}
			journal.task, err = tx.CreateTask(context.Background(), definition, encoded, durable.TaskOptions{Ownership: durable.TaskOwnership{Kind: "conversation"}, ConversationID: conversation.ID()})
			return err
		})
	}
	if err != nil {
		_ = harness.Close(context.Background())
		return nil, err
	}
	return journal, nil
}

func (r *RunExecution) durableTaskID() durable.TaskID {
	s := r.dependencies
	s.mu.Lock()
	defer s.mu.Unlock()
	if r.durable == nil {
		return 0
	}
	return r.durable.task
}

func (r *RunExecution) durableQueueLocked(kind string, message QueuedMessage) error {
	s := r.dependencies
	payload, err := queuePayload(message)
	if err != nil {
		return err
	}
	if r.durable == nil {
		// Recovered input remains editable before reviewed continuation. Use the
		// transactional kernel without resuming interrupted tasks or model calls.
		if r.Failure == nil || r.Failure.Kind != "interrupted" || r.recoveredJournal == 0 {
			return errors.New("The pending-message journal is no longer available")
		}
		storage, err := s.journals.openStorage(s.journals.dir(r.id))
		if err != nil {
			return err
		}
		journal := durable.NewSession(storage)
		defer journal.Close(context.Background())
		id := r.recoveredJournal
		return journal.CommitTransaction(context.Background(), durable.TransactionScope{ConversationID: &id}, func(tx *durable.Transaction) error {
			_, err := tx.AppendEntry(context.Background(), id, durable.EntryDraft{Kind: kind, Data: payload})
			return err
		})
	}
	return r.durable.harness.CommitConversation(context.Background(), r.durable.conversation, func(tx *durable.Transaction) error {
		_, err := tx.AppendEntry(context.Background(), r.durable.conversation, durable.EntryDraft{Kind: kind, Data: payload})
		return err
	})
}

func queuePayload(message QueuedMessage) (json.RawMessage, error) {
	return json.Marshal(struct {
		Message QueuedMessage          `json:"message"`
		Images  []aitypes.ImageContent `json:"images,omitempty"`
	}{message, message.Images})
}

func (r *RunExecution) recoverDurableLocked(id string) error {
	s := r.dependencies
	path := s.journals.dir(id)
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	storage, err := s.journals.openStorage(path)
	if err != nil {
		return err
	}
	defer storage.Close(context.Background())
	interrupted := false
	var conversationID durable.ConversationID
	var recoveredInput *durableInput
	var cursor durable.Cursor
	for {
		page, err := storage.ScanTasks(context.Background(), durable.TaskQuery{}, 256, cursor)
		if err != nil {
			return err
		}
		for _, task := range page.Items {
			if task.State.Status != durable.TaskStatusTerminal {
				interrupted = true
				conversationID = task.ConversationID
				var input durableInput
				if json.Unmarshal(task.Input, &input) == nil {
					recoveredInput = &input
				}
			}
		}
		if len(page.Next) == 0 {
			break
		}
		cursor = page.Next
	}
	if !interrupted {
		r.recoveredJournal, r.recoveredInput = 0, nil
		return nil
	}
	entries := []durable.EntryRecord{}
	cursor = nil
	for {
		page, err := storage.ScanEntries(context.Background(), durable.EntryQuery{ConversationID: conversationID}, 256, cursor)
		if err != nil {
			return err
		}
		entries = append(entries, page.Items...)
		if len(page.Next) == 0 {
			break
		}
		cursor = page.Next
	}
	pending := map[string]QueuedMessage{}
	order := []string{}
	for i := len(entries) - 1; i >= 0; i-- {
		entry := entries[i]
		var record struct {
			Message QueuedMessage          `json:"message"`
			Images  []aitypes.ImageContent `json:"images"`
		}
		if json.Unmarshal(entry.Data, &record) != nil {
			continue
		}
		switch entry.Kind {
		case "desk.queue":
			record.Message.Images = record.Images
			pending[record.Message.ID] = record.Message
			order = append(order, record.Message.ID)
		case "desk.queue-update":
			if old, ok := pending[record.Message.ID]; ok {
				record.Message.Images = record.Images
				pending[record.Message.ID] = record.Message
				if old.Mode != record.Message.Mode {
					for index, key := range order {
						if key == record.Message.ID {
							order = append(append(order[:index], order[index+1:]...), key)
							break
						}
					}
				}
			}
		case "desk.delivered", "desk.queue-delete":
			delete(pending, record.Message.ID)
		case "desk.clear-queue":
			pending = map[string]QueuedMessage{}
			order = nil
		}
	}
	var messages []QueuedMessage
	for _, key := range order {
		if message, ok := pending[key]; ok {
			messages = append(messages, message)
		}
	}
	// Publish only after every SDK scan succeeds, so a retry cannot observe a
	// partially recovered queue or lose the admitted request's attachments.
	r.recoveredJournal, r.recoveredInput = conversationID, recoveredInput
	r.QueuedMessages = messages
	r.Runtime.Phase = "interrupted"
	r.Failure = &Failure{Kind: "interrupted", Message: "A durable task was interrupted.", Advice: "Review and continue from the saved transcript. Uncertain commands and external actions are not replayed automatically.", CanContinue: true}
	return nil
}

// Live journal errors retain their public failure classification. Only the
// recovered input moves from durable state back to its owning execution.
func (r *RunExecution) recoverFailedJournalLocked() error {
	phase, failure := r.Runtime.Phase, r.Failure
	err := r.recoverDurableLocked(r.id)
	r.Runtime.Phase, r.Failure = phase, failure
	if err == nil {
		r.journalRecoveryNeeded = false
	}
	return err
}

// A per-service factory exposes the application's journal commit windows while
// default reads/writes continue through the pinned SDK's fsynced JSONL adapter.
func (j *TaskJournal) openStorage(path string) (durable.Storage, error) {
	if j.open != nil {
		return j.open(path)
	}
	return jsonl.Open(context.Background(), path, jsonl.Options{Fsync: true})
}
