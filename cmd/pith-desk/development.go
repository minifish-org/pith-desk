package main

import (
	"github.com/minifish-org/pith-desk/internal/desk"
	"github.com/minifish-org/pith-desk/internal/host"
)

func startHost(service *desk.Service, picker func() (string, error), development host.DevelopmentOptions, appearanceChanged ...func(desk.AppearanceMode)) (*host.Server, error) {
	if development.URL != "" {
		return host.StartDevelopment(service, picker, development, appearanceChanged...)
	}
	return host.Start(service, picker, appearanceChanged...)
}
