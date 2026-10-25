package desk

// Configure is the compact setup path used by service tests. Product callers
// use ConfigureProvider and SelectModel through the host.
func (s *Service) Configure(input ConfigInput) error {
	provider := input.Provider
	s.mu.Lock()
	if provider == "" {
		provider = s.connections.config.Provider
	}
	s.mu.Unlock()
	if provider == "" {
		provider = "deepseek"
	}
	if err := s.ConfigureProvider(ProviderConnectionInput{Provider: provider, BaseURL: input.BaseURL, APIKey: input.APIKey, ClearAPIKey: input.ClearAPIKey}); err != nil {
		return err
	}
	if input.Model == "" {
		return nil
	}
	return s.SelectModel(provider, input.Model, input.ThinkingLevel)
}
