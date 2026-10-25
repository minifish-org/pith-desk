// Package deskservice configures a real Desk service for tests without
// exposing test-only configuration methods on the production Service.
package deskservice

import "github.com/minifish-org/pith-desk/internal/desk"

func Configure(service *desk.Service, input desk.ConfigInput) error {
	provider := input.Provider
	if provider == "" {
		provider = service.Snapshot().Settings.Provider
	}
	if provider == "" {
		provider = "deepseek"
	}
	if err := service.ConfigureProvider(desk.ProviderConnectionInput{Provider: provider, BaseURL: input.BaseURL, APIKey: input.APIKey, ClearAPIKey: input.ClearAPIKey}); err != nil {
		return err
	}
	if input.Model == "" {
		return nil
	}
	return service.SelectModel(provider, input.Model, input.ThinkingLevel)
}
