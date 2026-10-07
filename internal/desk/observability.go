package desk

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"
	"time"

	agenttypes "github.com/minifish-org/pith/packages/agent/types"
	"github.com/minifish-org/pith/packages/ai"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
)

const Version = "0.1.0"

// Only structured metadata goes into the receipt or diagnostic export. Provider
// response bodies, prompts, paths, tool arguments and credentials never do.
type RunUsage struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cacheRead"`
	CacheWrite float64 `json:"cacheWrite"`
	Total      float64 `json:"total"`
}

// TaskTiming measures the latest admitted task, including tools, approvals,
// retries and compaction. Output comes from reported SDK request usage, rather
// than cumulative transcript tokens. A crash leaves only the saved checkpoint.
type TaskTiming struct {
	StartedAt    string  `json:"startedAt,omitempty"`
	ElapsedMs    int64   `json:"elapsedMs"`
	OutputTokens float64 `json:"outputTokens"`
	Partial      bool    `json:"partial,omitempty"`
}

type RuntimeStatus struct {
	RunID         string      `json:"runId,omitempty"`
	Provider      string      `json:"provider,omitempty"`
	ThinkingLevel string      `json:"thinkingLevel,omitempty"`
	Phase         string      `json:"phase"`
	Model         string      `json:"model"`
	Usage         RunUsage    `json:"usage"`
	Cost          CostSummary `json:"cost"`
	Timing        TaskTiming  `json:"timing"`
	ContextTokens float64     `json:"contextTokens"`
	ContextWindow float64     `json:"contextWindow"`
	Compactions   int         `json:"compactions"`
	ToolFailures  int         `json:"toolFailures"`
	UpdatedAt     string      `json:"updatedAt,omitempty"`
}

type Failure struct {
	Kind        string `json:"kind"`
	Message     string `json:"message"`
	Advice      string `json:"advice"`
	CanContinue bool   `json:"canContinue"`
}

type runReceipt struct {
	Runtime RuntimeStatus `json:"runtime"`
	Failure *Failure      `json:"failure,omitempty"`
}

func classifyFailure(err error, phase string) *Failure {
	text := strings.ToLower(err.Error())
	f := &Failure{Kind: "local", Message: "The task could not finish.", Advice: "Check the workspace and its instructions, then review the conversation before continuing.", CanContinue: true}
	var provider *codingagent.TerminalRequestError
	switch {
	case strings.Contains(text, "401") || strings.Contains(text, "403") || strings.Contains(text, "unauthorized") || strings.Contains(text, "authentication") || strings.Contains(text, "invalid api key"):
		f.Kind, f.Message, f.Advice, f.CanContinue = "credentials", "The provider rejected the credentials.", "Check the API key and endpoint in Settings, then test the connection.", false
	case strings.Contains(text, "model") && (strings.Contains(text, "not found") || strings.Contains(text, "does not exist") || strings.Contains(text, "404")):
		f.Kind, f.Message, f.Advice, f.CanContinue = "model", "The provider could not find this model.", "Check the model ID and endpoint in Settings, then test the connection.", false
	case strings.Contains(text, "429") || strings.Contains(text, "rate limit"):
		f.Kind, f.Message, f.Advice = "rate-limit", "The provider is limiting requests.", "Wait before continuing; check your provider's usage limits."
	case strings.Contains(text, "connection") || strings.Contains(text, "timeout") || strings.Contains(text, "timed out") || strings.Contains(text, "dial tcp") || strings.Contains(text, "eof") || strings.Contains(text, "network") || strings.Contains(text, "502") || strings.Contains(text, "503") || strings.Contains(text, "504"):
		f.Kind, f.Message, f.Advice = "network", "The model request was interrupted.", "Check your connection or provider status, then review and continue."
	case phase == "compacting":
		f.Kind, f.Message, f.Advice = "compaction", "Context summarization failed.", "History is preserved. Check the model connection before continuing."
	case strings.Contains(text, "400") || strings.Contains(text, "unsupported") || strings.Contains(text, "invalid request"):
		f.Kind, f.Message, f.Advice, f.CanContinue = "compatibility", "The endpoint rejected the request format.", "Check the provider, model and API endpoint in Settings.", false
	case errors.As(err, &provider):
		f.Kind, f.Message, f.Advice = "provider", "The provider could not complete the task.", "Test the connection or check the provider, then review and continue."
	}
	return f
}

func (r *conversationRuntime) updateRuntimeLocked(manager *codingagent.SessionManager) {
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

func (r *conversationRuntime) updateTimingLocked() {
	if !r.runStarted.IsZero() {
		r.Runtime.Timing.ElapsedMs = time.Since(r.runStarted).Milliseconds()
	}
}

func (r *conversationRuntime) observedCompactionPolicy(model *aitypes.Model, key string) codingagent.RunPolicy {
	s := r.service
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

func (s *Service) receiptFile(id string) string { return filepath.Join(s.dataDir, "runs", id+".json") }

func (r *conversationRuntime) loadRuntimeLocked(id string) error {
	s := r.service
	var receipt runReceipt
	if err := readJSON(s.receiptFile(id), &receipt); err != nil {
		return err
	}
	r.Runtime, r.Failure = receipt.Runtime, receipt.Failure
	if report, err := s.costsLocked(id, true); err != nil {
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
func (s *Service) ContinueTask(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.active
	if id != s.state.ActiveID || s.active.Failure == nil || !s.active.Failure.CanContinue {
		return errors.New("Open an interrupted conversation and review it before continuing")
	}
	pending := append([]QueuedMessage(nil), s.active.QueuedMessages...)
	instruction := "Review the previous conversation and inspect the current workspace before continuing the unfinished task. Successful actions may already have taken effect. Do not repeat completed writes, commands, or external actions. If an external action has an uncertain result, ask me to confirm it before proceeding."
	var images []aitypes.ImageContent
	if r.recoveredInput != nil && len(s.active.Messages) == 0 {
		instruction += "\nThe admitted request was: " + r.recoveredInput.Text
		images = r.recoveredInput.Images
	}
	err := s.sendLocked(instruction, images...)
	if err != nil {
		return err
	}
	for _, message := range pending {
		message.ID = newID()
		if err := r.durableQueueLocked("desk.queue", message); err != nil {
			return err
		}
		s.active.QueuedMessages = append(s.active.QueuedMessages, message)
	}
	return nil
}

type ConnectionTest struct {
	OK          bool   `json:"ok"`
	Kind        string `json:"kind"`
	Message     string `json:"message"`
	ToolCalling bool   `json:"toolCalling"`
	DurationMs  int64  `json:"durationMs"`
}

// TestConnection sends one small tool-call probe through the same Pith adapter.
// It never saves the form, loads a workspace, executes tools or changes history.
func (s *Service) TestConnection(ctx context.Context, input ConfigInput) (ConnectionTest, error) {
	s.mu.Lock()
	if err := s.idleLocked(); err != nil {
		s.mu.Unlock()
		return ConnectionTest{}, err
	}
	config, err := validatedConfig(input, s.config)
	if err != nil {
		s.mu.Unlock()
		return ConnectionTest{}, err
	}
	if !connectionReady(config.Connections[config.Provider]) {
		s.mu.Unlock()
		return ConnectionTest{}, errors.New("Enter an API key to test the connection")
	}

	ctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	s.probeCancel, s.probeDone = cancel, done
	s.mu.Unlock()
	defer func() {
		cancel()
		s.mu.Lock()
		s.probeCancel, s.probeDone = nil, nil
		s.mu.Unlock()
		close(done)
	}()
	model, _ := resolveConfiguredModel(config)
	started := time.Now()
	// This budget is only for the tiny connectivity probe, not agent tasks.
	maxTokens, retries := 256, 0
	probeThinking := aitypes.ThinkingLevel(ai.ClampThinkingLevel(*model, aitypes.ModelThinkingLevel("off")))
	options := &aitypes.SimpleStreamOptions{StreamOptions: aitypes.StreamOptions{
		ProviderRequestOptions: aitypes.ProviderRequestOptions{APIKey: &config.APIKey, Signal: ctx.Done(), MaxRetries: &retries}, MaxTokens: &maxTokens}, Reasoning: &probeThinking}
	transcript := aitypes.NormalizeContext(aitypes.Context{
		Messages: []aitypes.Message{aitypes.NewUserMessageVariant(aitypes.NewUserMessage("Call connection_check with ok=true. Do not write an explanation.", float64(time.Now().UnixMilli())))},
		Tools:    []aitypes.Tool{{Name: "connection_check", Description: "Confirm that tool calling works. This probe has no effects.", Input: aitypes.JSONSchemaToolInput(json.RawMessage(`{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false}`))}},
	})
	streamFn, streamErr := streamForConfigWithAuthGate(ctx, config, s.modelAuthGate)
	if streamErr != nil {
		return ConnectionTest{}, streamErr
	}
	stream := streamFn(model, transcript, options)
	message, err := stream.Result(ctx)
	result := ConnectionTest{DurationMs: time.Since(started).Milliseconds()}
	if ctx.Err() != nil {
		return result, ctx.Err()
	}
	if err == nil && (message.StopReason == aitypes.StopReasonError || message.StopReason == aitypes.StopReasonAborted) {
		text := "model request failed"
		if message.ErrorMessage != nil {
			text = *message.ErrorMessage
		}
		err = &codingagent.TerminalRequestError{Message: text, StopReason: message.StopReason}
	}
	if err != nil {
		failure := classifyFailure(err, "working")
		result.Kind, result.Message = failure.Kind, failure.Message+" "+failure.Advice
		return result, nil
	}
	for _, block := range message.Content {
		if block.IsToolCall() && block.ToolCall.Name == "connection_check" {
			var args struct {
				OK bool `json:"ok"`
			}
			if json.Unmarshal(block.ToolCall.Arguments, &args) == nil && args.OK {
				result.ToolCalling = true
			}
		}
	}
	result.OK = result.ToolCalling
	result.Kind, result.Message = "connected", "Streaming and tool calling succeeded. Settings have not been saved."
	if !result.ToolCalling {
		result.Kind, result.Message = "tool-calling", "The endpoint replied, but tool calling was not confirmed. Check that the selected model supports tool calling."
	}
	return result, nil
}

func (s *Service) Diagnostics() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	pithVersion := "unknown"
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, dep := range info.Deps {
			if dep.Path == "github.com/minifish-org/pith" {
				pithVersion = dep.Version
			}
		}
	}
	// Construct an allowlist instead of trying to redact arbitrary transcripts.
	diagnostic := struct {
		Version            string        `json:"version"`
		PithVersion        string        `json:"pithVersion"`
		OS                 string        `json:"os"`
		Architecture       string        `json:"architecture"`
		GoVersion          string        `json:"goVersion"`
		CreatedAt          string        `json:"createdAt"`
		Running            bool          `json:"running"`
		Runtime            RuntimeStatus `json:"runtime"`
		FailureKind        string        `json:"failureKind,omitempty"`
		WorkspaceCount     int           `json:"workspaceCount"`
		ConversationCount  int           `json:"conversationCount"`
		EnabledConnections int           `json:"enabledConnections"`
		Cost               string        `json:"cost"`
	}{Version: Version, PithVersion: pithVersion, OS: runtime.GOOS, Architecture: runtime.GOARCH, GoVersion: runtime.Version(), CreatedAt: timestamp(), Running: s.active.Running, Runtime: s.active.Runtime, WorkspaceCount: len(s.state.Workspaces), ConversationCount: len(s.state.Conversations), Cost: "See request ledger: SDK token usage priced with a recorded catalog or user price snapshot, in USD. Estimates are not provider bills."}
	if s.active.Failure != nil {
		diagnostic.FailureKind = s.active.Failure.Kind
	}
	for _, c := range s.mcpConfigs {
		if c.Enabled {
			diagnostic.EnabledConnections++
		}
	}
	data, err := json.MarshalIndent(diagnostic, "", "  ")
	if err != nil {
		return "", fmt.Errorf("export diagnostics: %w", err)
	}
	return string(data) + "\n", nil
}

func (r *conversationRuntime) compactionWithStream(model *aitypes.Model, key string, stream agenttypes.StreamFn) codingagent.RunPolicy {
	s := r.service
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
