package main

import (
	"context"
	"errors"
	"os"
	"sync/atomic"
	"testing"

	"github.com/egoist/mygo"
	"github.com/minifish-org/pith-desk/internal/desk"
	"github.com/minifish-org/pith-desk/internal/host"
	"github.com/minifish-org/pith-desk/internal/wire"
)

func TestUpdatesNativeSettingsProgressFailureAndDraftSave(t *testing.T) {
	if os.Getenv("PITH_DESK_NATIVE_SMOKE") != "1" {
		t.Skip("set PITH_DESK_NATIVE_SMOKE=1")
	}
	service, err := desk.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	w, err := service.AddWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	conversation, err := service.CreateConversation(w.ID)
	if err != nil {
		t.Fatal(err)
	}
	server, err := host.Start(service, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	var win *mygo.Window
	mygo.RunOnMain(func() {
		win = mygo.NewWindow(mygo.WindowOptions{Title: "Pith Desk update smoke", Hidden: true, Width: 1320, Height: 860})
	})
	defer win.Destroy()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var installed atomic.Int32
	var relaunched atomic.Bool
	proceed := make(chan struct{})
	u := &desktopUpdater{
		ctx: ctx, exit: &quitConfirmation{}, state: wire.UpdateStatus{Version: "0.1.0-rc.19", Enabled: true, Phase: "idle"},
		pause: service.PauseTaskAdmission, active: func() bool { return false }, flush: func() error { return flushDesktopDrafts(win) },
		relaunch: func() { relaunched.Store(true) },
	}
	u.check = func(context.Context) (*desktopUpdate, error) {
		return &desktopUpdate{version: "0.1.0-rc.20", install: func(ctx context.Context, progress func(int64, int64)) error {
			if installed.Add(1) == 1 {
				return errors.New("Update signature was rejected; the installed app was preserved.")
			}
			progress(50, 100)
			select {
			case <-proceed:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		}}, nil
	}
	server.SetUpdateActions(u.status, u.start)
	if err := win.Page().LoadURL(server.URL); err != nil {
		t.Fatal(err)
	}
	waitNativeDropCondition(t, win, `document.querySelector('[id$=composer-input]')?.readOnly === false`)
	nativeDropEval(t, win, `document.querySelector('[data-action="settings"]').click(); return true;`)
	waitNativeDropCondition(t, win, `document.querySelector('[data-update-version]')?.textContent === 'Pith Desk 0.1.0-rc.19' && !document.querySelector('[data-update-check]').disabled`)
	nativeDropEval(t, win, `document.querySelector('[data-update-check]').click(); return true;`)
	waitNativeDropCondition(t, win, `!document.querySelector('[data-update-install]').hidden && !document.querySelector('[data-update-install]').disabled`)
	saveUsabilityScreenshot(t, win, "update-available.png")
	nativeDropEval(t, win, `document.querySelector('[data-update-install]').click(); return true;`)
	waitNativeDropCondition(t, win, `document.querySelector('[data-update-message]')?.textContent.includes('signature was rejected') && !document.querySelector('[data-update-install]').disabled`)
	if relaunched.Load() {
		t.Fatal("rejected signature restarted the app")
	}
	nativeDropEval(t, win, `document.querySelector('[data-update-install]').click(); return true;`)
	waitNativeDropCondition(t, win, `document.querySelector('[id$=update-settings] progress')?.value === 50 && !document.querySelector('[id$=update-settings] progress').hidden`)
	saveUsabilityScreenshot(t, win, "update-progress.png")
	nativeDropEval(t, win, `document.querySelector('[data-close$="settings-dialog"]').click(); const input=document.querySelector('[id$=composer-input]');input.value='Last draft while updating 中文';input.dispatchEvent(new Event('input',{bubbles:true}));return true;`)
	close(proceed)
	waitUpdatePhase(t, u, "restarting")
	waitSavedDraft(t, service, conversation.ID, "Last draft while updating 中文")
	t.Log("Native Settings checked a release, displayed progress and signature rejection, retried, and saved text typed during installation before restart.")
}
