//go:build !linux

package main

import "github.com/egoist/mygo"

func prepareDesktopWindowControls(_ *mygo.WindowOptions) {}
func installDesktopWindowControls(_ *mygo.Window) func() { return func() {} }
