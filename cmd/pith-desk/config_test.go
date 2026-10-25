package main

import (
	"testing"

	"github.com/minifish-org/pith-desk/internal/desk"
	"github.com/minifish-org/pith-desk/internal/testsupport/deskservice"
)

func configureTestService(t *testing.T, service *desk.Service, input desk.ConfigInput) error {
	t.Helper()
	return deskservice.Configure(service, input)
}
