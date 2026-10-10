package host

import (
	"bytes"
	"net/http"
	"reflect"
	"testing"

	"github.com/minifish-org/pith-desk/internal/desk"
)

func TestNativeMenuInputsAndSnapshotsStayOrderedAndDetach(t *testing.T) {
	service, err := desk.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	s := &Server{service: service}
	var inputs []NativeMenuStateInput
	var runs []int
	s.SetNativeMenuAction(func(state desk.State, input NativeMenuStateInput) {
		inputs = append(inputs, input)
		runs = append(runs, len(state.Runs))
	})
	ready := NativeMenuStateInput{Ready: true, ActiveID: "conversation", WorkspaceID: "workspace"}
	if err := s.SetNativeMenuState(ready); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	s.updateNativeMenuLocked(desk.State{Runs: []desk.RunSummary{{ConversationID: "conversation", NeedsApproval: true}}})
	s.mu.Unlock()
	s.clearNativeMenuAction()
	if err := s.SetNativeMenuState(ready); err == nil {
		t.Fatal("detached native menu accepted a page input")
	}
	want := []NativeMenuStateInput{{}, ready, ready, {}}
	if !reflect.DeepEqual(inputs, want) || !reflect.DeepEqual(runs, []int{0, 0, 1, 0}) {
		t.Fatalf("snapshot/input order changed: %+v, %v", inputs, runs)
	}
	if s.nativeMenuAction != nil || s.nativeMenuInput.Ready {
		t.Fatal("closed host retained menu observer or ready state")
	}
}

func TestNativeMenuStateRequiresAuthenticationAndRejectsUnknownFields(t *testing.T) {
	s := testServer(t)
	s.SetNativeMenuAction(func(desk.State, NativeMenuStateInput) {})
	for _, tc := range []struct {
		name, token, body string
		status            int
	}{
		{"no credential", "", `{"ready":true,"busy":false,"modal":false,"workspaceId":"","activeId":""}`, http.StatusUnauthorized},
		{"authenticated", s.token, `{"ready":true,"busy":false,"modal":false,"workspaceId":"","activeId":""}`, http.StatusOK},
		{"unknown field", s.token, `{"ready":true,"surprise":"code"}`, http.StatusBadRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req, err := http.NewRequest(http.MethodPost, s.URL+"/api/native-menu-state", bytes.NewBufferString(tc.body))
			if err != nil {
				t.Fatal(err)
			}
			if tc.token != "" {
				req.Header.Set("Authorization", "Bearer "+tc.token)
			}
			response, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != tc.status {
				t.Fatalf("status %d, want %d", response.StatusCode, tc.status)
			}
		})
	}
}
