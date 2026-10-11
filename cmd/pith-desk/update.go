package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/minifish-org/pith-desk/internal/desk"
	"github.com/minifish-org/pith-desk/internal/wire"
)

var releaseVersionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$`)

func desktopReleaseVersion(executable string) string {
	bundle := filepath.Dir(filepath.Dir(filepath.Dir(executable)))
	if filepath.Ext(bundle) != ".app" {
		return ""
	}
	data, err := os.ReadFile(filepath.Join(bundle, "Contents", "Resources", "pith-desk-release.json"))
	var info struct {
		Version string `json:"version"`
	}
	if err != nil || json.Unmarshal(data, &info) != nil || !releaseVersionPattern.MatchString(info.Version) {
		return ""
	}
	return info.Version
}

type desktopUpdate struct {
	version string
	install func(context.Context, func(int64, int64)) error
}

// One controller serves Settings and the native menu. The browser cannot
// provide a URL, signature or executable path to the updater.
type desktopUpdater struct {
	mu       sync.Mutex
	state    wire.UpdateStatus
	update   *desktopUpdate
	ctx      context.Context
	cancel   context.CancelFunc
	check    func(context.Context) (*desktopUpdate, error)
	pause    func() (func(), error)
	active   func() bool
	confirm  func() (bool, error)
	flush    func() error
	exit     *quitConfirmation
	relaunch func()
}

func newDesktopUpdater(service *desk.Service, window *mygo.Window, dialogMu *sync.Mutex, exit *quitConfirmation, releaseVersion string, development bool) *desktopUpdater {
	ctx, cancel := context.WithCancel(context.Background())
	enabled := releaseVersion != "" && !development && mygo.Updater.Enabled()
	u := &desktopUpdater{
		ctx: ctx, cancel: cancel, exit: exit,
		state:    wire.UpdateStatus{Version: desk.Version, Enabled: enabled, Phase: "idle"},
		pause:    service.PauseTaskAdmission,
		active:   func() bool { return len(service.Snapshot().Runs) != 0 },
		flush:    func() error { return flushDesktopDrafts(window) },
		relaunch: mygo.App.Relaunch,
	}
	if !enabled {
		u.state.Message = "Updates are available in release apps installed in a writable folder."
	}
	u.check = func(ctx context.Context) (*desktopUpdate, error) {
		up, err := mygo.Updater.Check(ctx)
		if err != nil || up == nil {
			return nil, err
		}
		return &desktopUpdate{version: up.Version, install: up.Install}, nil
	}
	u.confirm = func() (bool, error) {
		dialogMu.Lock()
		defer dialogMu.Unlock()
		if !u.active() {
			return true, nil
		}
		result, err := mygo.Dialog.Message(mygo.MessageOptions{
			Parent: window, Type: mygo.MessageWarning, Title: "Update Pith Desk?",
			Message: "Tasks are still running.",
			Detail:  "Updating will interrupt tasks in all workspaces, including tasks waiting for approval, and restart Pith Desk. Completed changes will remain in place.",
			Buttons: []string{"Cancel", "Update and restart"}, DefaultButton: 0, CancelButton: 0,
		})
		return result.Button == 1, err
	}
	return u
}

func (u *desktopUpdater) status() wire.UpdateStatus {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.state
}

func (u *desktopUpdater) start(action string) error {
	u.mu.Lock()
	defer u.mu.Unlock()
	if !u.state.Enabled {
		return errors.New(u.state.Message)
	}
	if u.ctx.Err() != nil {
		return errors.New("Pith Desk is closing")
	}
	if u.state.Phase == "checking" || u.state.Phase == "installing" || u.state.Phase == "restarting" {
		return errors.New("An update is already in progress")
	}
	switch action {
	case "check":
		u.state.Phase, u.state.Message = "checking", "Checking for updates…"
		go u.checkRelease()
	case "install":
		if u.update == nil {
			return errors.New("Check for updates first")
		}
		if !u.exit.prepareUpdate() {
			return errors.New("Pith Desk is preparing to quit")
		}
		u.state.Phase, u.state.Message, u.state.Progress = "installing", "Preparing update…", 0
		go u.installRelease(u.update)
	default:
		return errors.New("Choose check or install")
	}
	return nil
}

func (u *desktopUpdater) checkRelease() {
	ctx, cancel := context.WithTimeout(u.ctx, 30*time.Second)
	defer cancel()
	up, err := u.check(ctx)
	u.mu.Lock()
	defer u.mu.Unlock()
	if err != nil {
		u.state.Phase, u.state.Message = "error", fmt.Sprintf("Could not check for updates: %v", err)
		return
	}
	u.update = up
	u.state.AvailableVersion = ""
	if up == nil {
		u.state.Phase, u.state.Message = "current", "Pith Desk is up to date."
		return
	}
	u.state.AvailableVersion = up.version
	u.state.Phase, u.state.Message = "available", "Version "+up.version+" is available."
}

func (u *desktopUpdater) installRelease(up *desktopUpdate) {
	success := false
	defer func() {
		u.exit.finishUpdate(success)
		if success {
			u.relaunch()
		}
	}()
	resume, err := u.pause()
	if err != nil {
		u.fail(err)
		return
	}
	defer func() {
		if !success {
			resume()
		}
	}()
	if u.active() {
		allow, err := u.confirm()
		if err != nil {
			u.fail(err)
			return
		}
		if !allow {
			u.mu.Lock()
			u.state.Phase, u.state.Message = "available", "Update canceled."
			u.mu.Unlock()
			return
		}
	}
	if err := u.flush(); err != nil {
		u.fail(err)
		return
	}
	ctx, cancel := context.WithTimeout(u.ctx, 15*time.Minute)
	defer cancel()
	err = up.install(ctx, func(downloaded, total int64) {
		u.mu.Lock()
		defer u.mu.Unlock()
		u.state.Message = "Downloading and installing update…"
		if total > 0 {
			u.state.Progress = min(100, max(0, float64(downloaded)*100/float64(total)))
		}
	})
	if err != nil {
		u.fail(err)
		return
	}
	// Save text entered while the update was downloading as well.
	if err := u.flush(); err != nil {
		u.mu.Lock()
		u.update = nil
		u.state.AvailableVersion = ""
		u.mu.Unlock()
		u.fail(fmt.Errorf("Update installed, but drafts could not be saved. Save your text and restart Pith Desk: %w", err))
		return
	}
	u.mu.Lock()
	u.state.Phase, u.state.Message, u.state.Progress = "restarting", "Restarting Pith Desk…", 100
	u.mu.Unlock()
	success = true
}

func (u *desktopUpdater) fail(err error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.state.Phase, u.state.Message = "error", err.Error()
}
