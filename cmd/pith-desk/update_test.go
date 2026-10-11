package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/minifish-org/pith-desk/internal/wire"
)

func TestUpdateInstallsAndRelaunchesWithoutIdleConfirmation(t *testing.T) {
	var calls []string
	u := updateFixture(t, &calls)
	u.confirm = func() (bool, error) { t.Fatal("idle update asked for confirmation"); return false, nil }
	u.exit.prepareUpdate()
	u.installRelease(&desktopUpdate{version: "0.1.0-rc.20", install: func(_ context.Context, progress func(int64, int64)) error {
		calls = append(calls, "install")
		if prevent, start := u.exit.request(); !prevent || start {
			t.Fatal("quit interrupted installation")
		}
		progress(5, 10)
		if u.status().Progress != 50 {
			t.Fatal("download progress was not reported")
		}
		return nil
	}})
	if strings.Join(calls, ",") != "pause,flush,install,flush,relaunch" {
		t.Fatalf("wrong update order: %v", calls)
	}
	assertAuthorizedQuit(t, u.exit)
	if u.status().Phase != "restarting" {
		t.Fatal("successful update did not restart")
	}
}

func TestUpdateActiveTaskConfirmationCancellationAndFailures(t *testing.T) {
	for _, name := range []string{"confirm", "cancel", "dialog error", "draft error", "download or signature error", "second draft error"} {
		t.Run(name, func(t *testing.T) {
			var calls []string
			u := updateFixture(t, &calls)
			u.active = func() bool { return true }
			u.confirm = func() (bool, error) {
				calls = append(calls, "confirm")
				if name == "dialog error" {
					return false, errors.New("dialog failed")
				}
				return name != "cancel", nil
			}
			saves := 0
			u.flush = func() error {
				calls = append(calls, "flush")
				saves++
				if name == "draft error" || (name == "second draft error" && saves == 2) {
					return errors.New("disk full")
				}
				return nil
			}
			u.exit.prepareUpdate()
			u.installRelease(&desktopUpdate{install: func(context.Context, func(int64, int64)) error {
				calls = append(calls, "install")
				if name == "download or signature error" {
					return errors.New("signature mismatch")
				}
				return nil
			}})
			joined := strings.Join(calls, ",")
			if name == "confirm" {
				if joined != "pause,confirm,flush,install,flush,relaunch" {
					t.Fatal(joined)
				}
				assertAuthorizedQuit(t, u.exit)
				return
			}
			if strings.Contains(joined, "relaunch") || !strings.HasSuffix(joined, "resume") {
				t.Fatalf("failed update did not preserve the app: %s", joined)
			}
			if name == "cancel" || name == "dialog error" || name == "draft error" {
				if strings.Contains(joined, "install") {
					t.Fatal("cancellation/failure still replaced the app")
				}
			}
			if prevent, start := u.exit.request(); !prevent || !start {
				t.Fatal("failed update prevented ordinary quit")
			}
		})
	}
}

func updateFixture(t *testing.T, calls *[]string) *desktopUpdater {
	t.Helper()
	return &desktopUpdater{
		ctx: context.Background(), state: wire.UpdateStatus{Enabled: true, Phase: "installing"}, exit: &quitConfirmation{},
		pause: func() (func(), error) {
			*calls = append(*calls, "pause")
			return func() { *calls = append(*calls, "resume") }, nil
		},
		active: func() bool { return false }, confirm: func() (bool, error) { return true, nil },
		flush:    func() error { *calls = append(*calls, "flush"); return nil },
		relaunch: func() { *calls = append(*calls, "relaunch") },
	}
}

func TestUpdateCheckCoalescesRequestsAndAllowsRetry(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	started, release := make(chan struct{}), make(chan struct{})
	u := &desktopUpdater{ctx: ctx, state: wire.UpdateStatus{Enabled: true}, check: func(context.Context) (*desktopUpdate, error) {
		close(started)
		<-release
		return nil, errors.New("offline")
	}}
	if err := u.start("check"); err != nil {
		t.Fatal(err)
	}
	<-started
	if err := u.start("check"); err == nil {
		t.Fatal("duplicate check started")
	}
	close(release)
	waitUpdatePhase(t, u, "error")
	u.check = func(context.Context) (*desktopUpdate, error) { return &desktopUpdate{version: "0.1.0-rc.20"}, nil }
	if err := u.start("check"); err != nil {
		t.Fatal(err)
	}
	waitUpdatePhase(t, u, "available")
	if u.status().AvailableVersion != "0.1.0-rc.20" {
		t.Fatal("check lost preview version")
	}
	if err := u.start("unknown"); err == nil {
		t.Fatal("unknown update action accepted")
	}
}

func waitUpdatePhase(t *testing.T, u *desktopUpdater, phase string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if u.status().Phase == phase {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("update did not reach %s: %+v", phase, u.status())
}

func TestDesktopReleaseVersionRequiresReleaseBundleIdentity(t *testing.T) {
	root := t.TempDir()
	app := filepath.Join(root, "Pith Desk.app")
	resources := filepath.Join(app, "Contents", "Resources")
	os.MkdirAll(resources, 0o755)
	executable := filepath.Join(app, "Contents", "MacOS", "Pith Desk")
	metadata := filepath.Join(resources, "pith-desk-release.json")
	for _, bad := range []string{`{}`, `{"version":"unknown"}`, `invalid`} {
		os.WriteFile(metadata, []byte(bad), 0o600)
		if desktopReleaseVersion(executable) != "" {
			t.Fatal("invalid release identity accepted")
		}
	}
	os.WriteFile(metadata, []byte(`{"version":"0.1.0-rc.20"}`), 0o600)
	if desktopReleaseVersion(executable) != "0.1.0-rc.20" {
		t.Fatal("release identity was not read")
	}
	if desktopReleaseVersion(filepath.Join(root, "pith-desk")) != "" {
		t.Fatal("development executable became a release")
	}
}
