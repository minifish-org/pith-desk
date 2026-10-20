package pithdesk

import "embed"

// Web contains the shared frontend embedded in both Desktop and Server.
//
//go:embed frontend/dist
var Web embed.FS
