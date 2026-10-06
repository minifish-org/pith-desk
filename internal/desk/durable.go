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
	storage      *jsonl.Storage
	conversation durable.ConversationID
	task         durable.TaskID
}

type durableInput struct {
	RunID   string                 `json:"runId"`
	Text    string                 `json:"text"`
	Images  []aitypes.ImageContent `json:"images,omitempty"`
	Compact bool                   `json:"compact"`
}

func (s *Service) durableDir(id string) string { return filepath.Join(s.dataDir, "durable", id) }

func (s *Service) admitDurableLocked(id string, workspace Workspace, config savedConfig, model *aitypes.Model, input durableInput) (*deskDurable, error) {
	path := s.durableDir(id)
	if err := os.MkdirAll(path, 0700); err != nil {
		return nil, err
	}
	storage, err := jsonl.Open(context.Background(), path, jsonl.Options{Fsync: true})
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
		if record.ID != s.durableTaskID() {
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
		s.run(ctx, id, workspace, config, model, input.Text, input.Images, input.Compact)
		s.mu.Lock()
		phase := s.state.Runtime.Phase
		closed := s.closed
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
	harness, err := dh.Open(context.Background(), storage, dh.Options{Registry: registry})
	if err != nil {
		_ = storage.Close(context.Background())
		return nil, err
	}
	conversation, err := harness.Root(context.Background(), dh.RootOptions{})
	if err != nil {
		_ = harness.Close(context.Background())
		return nil, err
	}
	journal := &deskDurable{harness: harness, storage: storage, conversation: conversation.ID()}
	encoded, err := json.Marshal(input)
	if err == nil {
		err = harness.CommitConversation(context.Background(), conversation.ID(), func(tx *durable.Transaction) error {
			if _, err := tx.AppendEntry(context.Background(), conversation.ID(), durable.EntryDraft{Kind: "desk.clear-queue", Data: json.RawMessage(`{}`)}); err != nil {
				return err
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

func (s *Service) durableTaskID() durable.TaskID {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.durable == nil {
		return 0
	}
	return s.durable.task
}

func (s *Service) durableQueueLocked(kind string, message QueuedMessage) error {
	if s.durable == nil {
		return nil
	}
	payload, err := json.Marshal(struct {
		Message QueuedMessage          `json:"message"`
		Images  []aitypes.ImageContent `json:"images,omitempty"`
	}{message, message.Images})
	if err != nil {
		return err
	}
	return s.durable.harness.CommitConversation(context.Background(), s.durable.conversation, func(tx *durable.Transaction) error {
		_, err := tx.AppendEntry(context.Background(), s.durable.conversation, durable.EntryDraft{Kind: kind, Data: payload})
		return err
	})
}

func (s *Service) recoverDurableLocked(id string) error {
	path := s.durableDir(id)
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	storage, err := jsonl.Open(context.Background(), path, jsonl.Options{Fsync: true})
	if err != nil {
		return err
	}
	defer storage.Close(context.Background())
	interrupted := false
	var conversationID durable.ConversationID
	s.recoveredInput = nil
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
					s.recoveredInput = &input
				}
			}
		}
		if len(page.Next) == 0 {
			break
		}
		cursor = page.Next
	}
	if !interrupted {
		return nil
	}
	s.state.Runtime.Phase = "interrupted"
	s.state.Failure = &Failure{Kind: "interrupted", Message: "A durable task was interrupted.", Advice: "Review and continue from the saved transcript. Uncertain commands and external actions are not replayed automatically.", CanContinue: true}
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
		case "desk.delivered":
			delete(pending, record.Message.ID)
		case "desk.clear-queue":
			pending = map[string]QueuedMessage{}
		}
	}
	s.state.QueuedMessages = nil
	for _, key := range order {
		if message, ok := pending[key]; ok {
			s.state.QueuedMessages = append(s.state.QueuedMessages, message)
		}
	}
	return nil
}
