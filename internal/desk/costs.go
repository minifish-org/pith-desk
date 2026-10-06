package desk

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	agenttypes "github.com/minifish-org/pith/packages/agent/types"
	"github.com/minifish-org/pith/packages/ai"
	"github.com/minifish-org/pith/packages/ai/catalog"
	aitypes "github.com/minifish-org/pith/packages/ai/types"
)

type RequestCost struct {
	ID           string            `json:"id"`
	RunID        string            `json:"runId"`
	Time         string            `json:"time"`
	Provider     string            `json:"provider"`
	ProviderName string            `json:"providerName,omitempty"`
	Model        string            `json:"model"`
	ModelName    string            `json:"modelName,omitempty"`
	Purpose      string            `json:"purpose"`
	Status       string            `json:"status"`
	Usage        aitypes.Usage     `json:"usage"`
	Price        aitypes.ModelCost `json:"price"`
	Source       string            `json:"source"`
	Known        bool              `json:"known"`
}

type CostSummary struct {
	Total              float64 `json:"total"`
	RunTotal           float64 `json:"runTotal"`
	RequestCount       int     `json:"requestCount"`
	UnknownRequests    int     `json:"unknownRequests"`
	RunRequests        int     `json:"runRequests"`
	RunUnknownRequests int     `json:"runUnknownRequests"`
	Unavailable        bool    `json:"unavailable,omitempty"`
}

func (summary *CostSummary) add(request RequestCost, currentRun bool) {
	summary.RequestCount++
	if currentRun {
		summary.RunRequests++
	}
	if !request.Known {
		summary.UnknownRequests++
		if currentRun {
			summary.RunUnknownRequests++
		}
		return
	}
	summary.Total += request.Usage.Cost.Total
	if currentRun {
		summary.RunTotal += request.Usage.Cost.Total
	}
}

type CostReport struct {
	CostSummary
	Currency  string        `json:"currency"`
	Estimated bool          `json:"estimated"`
	Requests  []RequestCost `json:"requests"`
}

func (s *Service) costFile(id string) string { return filepath.Join(s.dataDir, "costs", id+".jsonl") }

func (s *Service) Costs(id string) (CostReport, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conversationIndexLocked(id) < 0 {
		return CostReport{}, errors.New("Conversation not found")
	}
	return s.costsLocked(id, id == s.state.ActiveID)
}

func (s *Service) costsLocked(id string, includeRun bool) (CostReport, error) {
	report := CostReport{Currency: "USD", Estimated: true, Requests: []RequestCost{}}
	file, err := os.Open(s.costFile(id))
	if errors.Is(err, os.ErrNotExist) {
		return report, nil
	}
	if err != nil {
		return report, err
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	for {
		var request RequestCost
		if err = decoder.Decode(&request); errors.Is(err, io.EOF) {
			break
		} else if err != nil {
			return report, err
		}
		report.Requests = append(report.Requests, request)
		report.add(request, includeRun && request.RunID == s.state.Runtime.RunID)
	}
	return report, nil
}

func (s *Service) recordCost(id, runID, purpose string, model *aitypes.Model, config savedConfig, response aitypes.AssistantMessage) {
	usage := response.Usage
	known := usage.TotalTokens > 0 || usage.Input+usage.Output+usage.CacheRead+usage.CacheWrite > 0
	var manifest struct {
		GeneratedAt string `json:"generatedAt"`
	}
	_ = json.Unmarshal(catalog.V1Manifest(), &manifest)
	source := "Pith/Pi catalog snapshot: " + manifest.GeneratedAt
	if connection := config.Connections[config.Provider]; connection.API != "" {
		source = "User-configured USD prices"
		priced := false
		for _, m := range connection.Models {
			if m.ID == model.Id {
				priced = m.Cost != nil
			}
		}
		known = known && priced
	} else {
		known = known && (model.Cost.Input+model.Cost.Output+model.Cost.CacheRead+model.Cost.CacheWrite > 0)
		if config.BaseURL != "" && !catalogEndpoint(config.Provider, model.Id, config.BaseURL) {
			known = false
			source = "Endpoint override: configure this connection's prices"
		}
	}
	if known {
		ai.CalculateCost(*model, &usage)
	} else {
		usage.Cost = aitypes.UsageCost{}
	}
	record := RequestCost{ID: newID(), RunID: runID, Time: timestamp(), Provider: string(model.Provider), ProviderName: config.Connections[config.Provider].Name, Model: model.Id, ModelName: model.Name, Purpose: purpose, Status: string(response.StopReason), Usage: usage, Price: model.Cost, Source: source, Known: known}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(s.costFile(id)), 0700); err != nil {
		s.state.Error = err.Error()
		if id == s.state.ActiveID {
			s.state.Runtime.Cost.Unavailable = true
		}
		s.changedLocked()
		return
	}
	file, err := os.OpenFile(s.costFile(id), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err == nil {
		err = json.NewEncoder(file).Encode(record)
		if err == nil {
			err = file.Sync()
		}
		closeErr := file.Close()
		if err == nil {
			err = closeErr
		}
	}
	if err != nil {
		s.state.Error = "Could not save request usage: " + err.Error()
		if id == s.state.ActiveID {
			s.state.Runtime.Cost.Unavailable = true
		}
	} else if id == s.state.ActiveID {
		// The ledger is read once on opening a conversation. Streaming snapshots
		// use this small aggregate instead of rereading or sending all requests.
		s.state.Runtime.Cost.add(record, runID == s.state.Runtime.RunID)
	}
	s.changedLocked()
}

func catalogEndpoint(provider, id, endpoint string) bool {
	runtime, err := modelRuntime()
	if err != nil {
		return false
	}
	normalize := func(value string) string { return strings.TrimSuffix(strings.TrimRight(value, "/"), "/v1") }
	if model := runtime.GetModel(provider, id); model != nil && normalize(endpoint) == normalize(model.BaseUrl) {
		return true
	}
	if p := runtime.GetProvider(provider); p != nil && normalize(endpoint) == normalize(p.BaseURL()) {
		return true
	}
	return false
}

// Forward SDK events unchanged, but commit request usage before publishing the
// terminal event. Retries and summaries are separate ledger records, without
// double-counting message/session totals or recalculating old prices.
func (s *Service) meteredStream(ctx context.Context, id, runID string, config savedConfig, base agenttypes.StreamFn, purpose func() string) agenttypes.StreamFn {
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
