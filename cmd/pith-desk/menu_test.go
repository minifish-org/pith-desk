package main

import (
	"reflect"
	"testing"
	"time"

	"github.com/egoist/mygo"
	"github.com/minifish-org/pith-desk/internal/desk"
	"github.com/minifish-org/pith-desk/internal/host"
)

func TestNativeMenuPolicyUsesCurrentSessionAndAllLiveRuns(t *testing.T) {
	state := desk.State{Conversations: []desk.Conversation{{ID: "done", WorkspaceID: "one"}, {ID: "other", WorkspaceID: "two"}}}
	state.ActiveID = "done"
	input := host.NativeMenuStateInput{Ready: true, ActiveID: "done", WorkspaceID: "one"}
	if policy := nativeMenuPolicy(state, input); !policy.Export || !policy.NewConversation || !policy.ChooseWorkspace || !policy.Settings {
		t.Fatalf("idle session missing actions: %+v", policy)
	}
	state.Runs = []desk.RunSummary{{ConversationID: "other", WorkspaceID: "two", NeedsApproval: true}}
	if !nativeMenuPolicy(state, input).Export {
		t.Fatal("unrelated approval blocked exporting the completed session")
	}
	state.Runs = append(state.Runs, desk.RunSummary{ConversationID: "done", WorkspaceID: "one", NeedsApproval: true})
	if policy := nativeMenuPolicy(state, input); policy.Export || !policy.NewConversation || !policy.ChooseWorkspace || !policy.Settings {
		t.Fatalf("approval enablement differs from existing actions: %+v", policy)
	}
	state.Runs = nil
	state.ActiveID = "other"
	if nativeMenuPolicy(state, input).Export {
		t.Fatal("page selection lag allowed exporting the previous session")
	}
	state.ActiveID = "done"
	state.Conversations = nil
	if nativeMenuPolicy(state, input).Export {
		t.Fatal("deleted session remained exportable")
	}
	input.ActiveID, input.WorkspaceID = "", ""
	if !nativeMenuPolicy(state, input).NewConversation {
		t.Fatal("new conversation cannot open the first workspace picker")
	}
}

func TestNativeMenuPolicyBlocksBusyModalLoadingAndSignIn(t *testing.T) {
	for _, input := range []host.NativeMenuStateInput{
		{}, {Ready: true, Busy: true}, {Ready: true, Modal: true},
	} {
		if actual := nativeMenuPolicy(desk.State{}, input); actual != (nativeMenuAvailability{}) {
			t.Fatalf("blocked input exposed actions: %+v", actual)
		}
	}
	state := desk.State{Login: &desk.LoginStatus{}}
	if actual := nativeMenuPolicy(state, host.NativeMenuStateInput{Ready: true}); actual != (nativeMenuAvailability{}) {
		t.Fatalf("sign-in exposed actions: %+v", actual)
	}
}

func TestNativeMenuCoalescesUpdatesAndStopsAfterQuit(t *testing.T) {
	scheduled := make(chan func(), 4)
	var applied []nativeMenuAvailability
	c := &nativeMenuController{
		schedule:    func(fn func()) { scheduled <- fn },
		applyNative: func(value nativeMenuAvailability) { applied = append(applied, value) },
	}
	on := nativeMenuAvailability{NewConversation: true, ChooseWorkspace: true, Export: true, Settings: true}
	c.setAvailability(on)
	c.setAvailability(nativeMenuAvailability{})
	invokeMenuUpdate(t, scheduled)
	if !reflect.DeepEqual(applied, []nativeMenuAvailability{{}}) {
		t.Fatalf("queued stale state reached native menu: %+v", applied)
	}
	c.setAvailability(nativeMenuAvailability{})
	select {
	case <-scheduled:
		t.Fatal("unchanged menu scheduled more native work")
	default:
	}
	c.setAvailability(on)
	c.close()
	invokeMenuUpdate(t, scheduled)
	c.setAvailability(on)
	if c.permits("new-conversation") || !reflect.DeepEqual(applied, []nativeMenuAvailability{{}, {}}) {
		t.Fatalf("quit restored menu actions: %+v", applied)
	}
}

func TestNativeMenuShortcutsAndRolesDoNotDuplicateQuit(t *testing.T) {
	items := nativeMenuTemplate(func(string) {})
	view := false
	for _, item := range items {
		if item.Role == mygo.RoleViewMenu {
			view = true
			if item.Submenu != nil {
				t.Fatal("custom View submenu removed standard reload and developer tools")
			}
		}
	}
	if !view {
		t.Fatal("standard View menu is missing")
	}
	seen := map[string]string{}
	quit := 0
	var visit func([]*mygo.MenuItem)
	visit = func(items []*mygo.MenuItem) {
		for _, item := range items {
			if item.ID != "" {
				if _, exists := seen[item.Accelerator]; exists {
					t.Fatalf("duplicated shortcut %s", item.Accelerator)
				}
				seen[item.Accelerator] = item.ID
				if !item.Disabled {
					t.Fatalf("startup page action enabled: %s", item.ID)
				}
			}
			if item.Role == mygo.RoleQuit {
				quit++
				if item.Click != nil {
					t.Fatal("standard quit also invokes an independent click handler")
				}
			}
			visit(item.Submenu)
		}
	}
	visit(items)
	want := map[string]string{"CmdOrCtrl+N": "desk-new", "CmdOrCtrl+O": "desk-workspace", "CmdOrCtrl+Shift+E": "desk-export", "CmdOrCtrl+,": "desk-settings"}
	if !reflect.DeepEqual(seen, want) || quit != 1 {
		t.Fatalf("unexpected menu shortcuts or quit count: %v, %d", seen, quit)
	}
	if nativeMenuScript("settings'); alert('unexpected") != "false" {
		t.Fatal("unsupported action was evaluated as code")
	}
}

func invokeMenuUpdate(t *testing.T, scheduled <-chan func()) {
	t.Helper()
	select {
	case fn := <-scheduled:
		fn()
	case <-time.After(time.Second):
		t.Fatal("native menu update was not scheduled")
	}
}
