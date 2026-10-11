package desk

import (
	"context"
	agenttypes "github.com/minifish-org/pith/packages/agent/types"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
	"path/filepath"
	"time"
)

func (r *RunExecution) updateRuntimeLocked(manager *codingagent.SessionManager) {
	r.updateTimingLocked()
	if r.session != nil {
		stats := r.session.Stats()
		r.Runtime.Usage = RunUsage{stats.InputTokens, stats.OutputTokens, stats.CacheRead, stats.CacheWrite, stats.TotalTokens}
	}
	if manager != nil {
		r.Runtime.ContextTokens = codingagent.EstimateProjectedContextTokens(manager.BuildSessionProjection(), manager.BuildContextEntries()).Tokens
		count := 0
		for _, entry := range manager.Entries() {
			if entry.Type == "compaction" {
				count++
			}
		}
		r.Runtime.Compactions = count
	}
	r.Runtime.UpdatedAt = timestamp()
}

func (r *RunExecution) updateTimingLocked() {
	if !r.runStarted.IsZero() {
		r.Runtime.Timing.ElapsedMs = time.Since(r.runStarted).Milliseconds()
	}
}

func (r *RunExecution) observedCompactionPolicy(model *aitypes.Model, key string) codingagent.RunPolicy {
	s := r.dependencies
	policy := compactionPolicy(model, key)
	summarize := policy.Summarize
	policy.Summarize = func(ctx context.Context, messages []agenttypes.AgentMessage) (string, error) {
		s.mu.Lock()
		r.Runtime.Phase = "compacting"
		s.changedLocked()
		s.mu.Unlock()
		result, err := summarize(ctx, messages)
		if err == nil {
			s.mu.Lock()
			r.Runtime.Phase = "working"
			s.changedLocked()
			s.mu.Unlock()
		}
		return result, err
	}
	return policy
}

func (r *RunExecution) loadRuntimeLocked(id string) error {
	s := r.dependencies
	var receipt runReceipt
	if err := s.files.ReadJSON(s.receiptFile(id), &receipt); err != nil {
		return err
	}
	r.Runtime, r.Failure = receipt.Runtime, receipt.Failure
	if report, err := (CostLedger{path: filepath.Join(s.dataDir, "costs", id+".jsonl"), files: *s.files}).read(r.Runtime.RunID, true); err != nil {
		r.Runtime.Cost = CostSummary{Unavailable: true}
	} else {
		r.Runtime.Cost = report.CostSummary
	}
	switch receipt.Runtime.Phase {
	case "starting", "working", "tool", "retrying", "compacting":
		// Never count app downtime as execution or invent a speed for the
		// unknown interval after the last saved checkpoint.
		r.Runtime.Timing.Partial = true
		r.Runtime.Phase = "interrupted"
		r.Failure = &Failure{Kind: "interrupted", Message: "The previous task was interrupted when the app closed.", Advice: "Review the conversation and existing files before continuing. Completed actions are not automatically replayed.", CanContinue: true}
	}
	return r.recoverDurableLocked(id)
}

// ContinueTask is a new explicit instruction, never a replay of the old request.
// The SDK restores the canonical transcript, including completed tool results.
func (r *RunExecution) compactionWithStream(model *aitypes.Model, key string, stream agenttypes.StreamFn) codingagent.RunPolicy {
	s := r.dependencies
	policy := r.observedCompactionPolicy(model, key)
	policy.Summarize = func(ctx context.Context, messages []agenttypes.AgentMessage) (string, error) {
		s.mu.Lock()
		r.Runtime.Phase = "compacting"
		s.changedLocked()
		s.mu.Unlock()
		bound := func(m *aitypes.Model, t *aitypes.TranscriptContext, o *aitypes.SimpleStreamOptions) *aitypes.AssistantMessageEventStream {
			request := aitypes.SimpleStreamOptions{}
			if o != nil {
				request = *o
			}
			request.APIKey = &key
			return stream(m, t, &request)
		}
		text, err := codingagent.GenerateSummary(ctx, messages, model, codingagent.DefaultCompactionPolicy.ReserveTokens, bound, nil, nil)
		if err == nil {
			s.mu.Lock()
			r.Runtime.Phase = "working"
			s.changedLocked()
			s.mu.Unlock()
		}
		return text, err
	}
	return policy
}
