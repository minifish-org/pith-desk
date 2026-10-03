package pithdesk

import "embed"

// Web contains the frontend built before compiling the desktop executable.
//
//go:embed frontend/dist
var Web embed.FS
