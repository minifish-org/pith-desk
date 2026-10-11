package desk

import (
	"context"
	agenttypes "github.com/minifish-org/pith/packages/agent/types"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
)

// Use the SDK's normalized text events across all provider protocols. Reasoning,
// tool arguments and compaction summaries never become visible reply text.
func (r *conversationRuntime) appendAssistantText(event aitypes.AssistantMessageEvent) {
	if event.Type != aitypes.AssistantEventTextDelta || event.Delta == nil || *event.Delta == "" {
		return
	}
	s := r.service
	s.mu.Lock()
	defer s.mu.Unlock()
	last := len(r.Messages) - 1
	if last < 0 || r.Messages[last].Status != "streaming" {
		r.Messages = append(r.Messages, Message{ID: newID(), Role: "assistant", Status: "streaming"})
		last++
	}
	r.Messages[last].Text += *event.Delta
	s.changedLocked()
}

// Forward SDK events unchanged, but commit request usage before publishing the
// terminal event. Retries and summaries are separate ledger records, without
// double-counting message/session totals or recalculating old prices.
func (s *Service) meteredStream(ctx context.Context, id, runID string, config savedConfig, base agenttypes.StreamFn, purpose func() string, observe func(aitypes.AssistantMessageEvent)) agenttypes.StreamFn {
	return func(model *aitypes.Model, transcript *aitypes.TranscriptContext, options *aitypes.SimpleStreamOptions) *aitypes.AssistantMessageEventStream {
		requestPurpose := purpose()
		upstream := base(model, transcript, options)
		output := aitypes.NewAssistantMessageEventStream()
		go func() {
			for {
				select {
				case <-ctx.Done():
					// A settled response remains account-able even if cancellation
					// arrived before the forwarding goroutine ran.
					response, err := upstream.Result(ctx)
					if err == nil {
						s.recordCost(id, runID, requestPurpose, model, config, response)
					}
					output.End(nil)
					return
				case item := <-upstream.Next():
					if item.Done {
						output.End(nil)
						return
					}
					event := item.Value
					if requestPurpose == "agent" {
						observe(event)
					}
					if event.Type == "done" || event.Type == "error" {
						response, err := upstream.Result(ctx)
						if err == nil {
							s.recordCost(id, runID, requestPurpose, model, config, response)
						}
						output.Push(event)
						return
					}
					output.Push(event)
				}
			}
		}()
		return output
	}
}
