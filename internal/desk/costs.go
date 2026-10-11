package desk

import (
	"encoding/json"
	"errors"
	"math"
	"path/filepath"
	"strings"

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

func (s *Service) costLedger(id string) CostLedger {
	return CostLedger{path: s.costFile(id), files: s.files}
}

func (s *Service) Costs(id string) (CostReport, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conversationIndexLocked(id) < 0 {
		return CostReport{}, errors.New("Conversation not found")
	}
	return s.costsLocked(id, true)
}

func (s *Service) costsLocked(id string, includeRun bool) (CostReport, error) {
	runID := ""
	if includeRun {
		if r := s.runtimes[id]; r != nil {
			runID = r.Runtime.RunID
		} else {
			var receipt runReceipt
			if err := s.files.ReadJSON(s.receiptFile(id), &receipt); err != nil {
				return CostReport{}, err
			}
			runID = receipt.Runtime.RunID
		}
	}
	return s.costLedger(id).read(runID, includeRun)
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
	r := s.runtimes[id]
	if r != nil && runID == r.Runtime.RunID && r.Runtime.Timing.StartedAt != "" {
		// Usage remains useful even when this endpoint has no known price.
		if usage.Output >= 0 && !math.IsNaN(usage.Output) && !math.IsInf(usage.Output, 0) {
			r.Runtime.Timing.OutputTokens += usage.Output
		}
		r.updateTimingLocked()
	}
	if err := s.costLedger(id).ensureDirectory(); err != nil {
		if r != nil {
			r.Error = err.Error()
			r.Runtime.Cost.Unavailable = true
		}
		s.changedLocked()
		return
	}
	err := s.costLedger(id).append(record)

	if err != nil {
		if r != nil {
			r.Error = "Could not save request usage: " + err.Error()
		}
		if r != nil {
			r.Runtime.Cost.Unavailable = true
		}
	} else if r != nil {
		// The ledger is read once on opening a conversation. Streaming snapshots
		// use this small aggregate instead of rereading or sending all requests.
		r.Runtime.Cost.add(record, runID == r.Runtime.RunID)
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
