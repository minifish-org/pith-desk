package desk

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestWorkspaceCaseAliasesCannotExposePrivateData(t *testing.T) {
	base := t.TempDir()
	parent := filepath.Join(base, "Profile")
	private := filepath.Join(parent, "PrivateData")
	s, err := New(private)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	alias := filepath.Join(parent, "privatedata")
	if _, err := os.Stat(alias); os.IsNotExist(err) {
		t.Skip("volume distinguishes case variants")
	} else if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(private, "sessions"), 0700); err != nil && !os.IsExist(err) {
		t.Fatal(err)
	}
	for _, path := range []string{alias, filepath.Join(alias, "sessions"), filepath.Join(base, "profile")} {
		if _, err := s.AddWorkspace(path); err == nil {
			t.Errorf("private application directory accepted as a workspace: %q", path)
		}
	}
	if len(s.Snapshot().Workspaces) != 0 {
		t.Fatal("rejected private directories entered the catalog")
	}
}

func TestWorkspaceCaseVariantsUseDirectoryIdentity(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	base := t.TempDir()
	first, second := filepath.Join(base, "Project"), filepath.Join(base, "project")
	for _, path := range []string{first, second} {
		if err := os.MkdirAll(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	firstInfo, err := os.Stat(first)
	if err != nil {
		t.Fatal(err)
	}
	secondInfo, err := os.Stat(second)
	if err != nil {
		t.Fatal(err)
	}
	a, err := s.AddWorkspace(first)
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.AddWorkspace(second)
	if err != nil {
		t.Fatal(err)
	}
	same := os.SameFile(firstInfo, secondInfo)
	if (a.ID == b.ID) != same {
		t.Fatalf("workspace IDs must follow real directory identity: same=%v, first=%+v, second=%+v", same, a, b)
	}
	want := 2
	if same {
		want = 1
	}
	if got := len(s.Snapshot().Workspaces); got != want {
		t.Fatalf("catalog has %d workspaces, want %d", got, want)
	}
}

func TestWorkspaceCaseAliasAncestorCannotRunAlongsideChild(t *testing.T) {
	base := t.TempDir()
	parent, alias := filepath.Join(base, "Project"), filepath.Join(base, "project")
	child := filepath.Join(parent, "nested")
	if err := os.MkdirAll(child, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(alias); os.IsNotExist(err) {
		t.Skip("volume distinguishes case variants")
	} else if err != nil {
		t.Fatal(err)
	}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		startSSE(w)
		sse(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": "Waiting"}}}})
		<-r.Context().Done()
	}))
	t.Cleanup(provider.Close)
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	if err := s.Configure(ConfigInput{BaseURL: provider.URL + "/v1", Model: "deepseek-flash", APIKey: "fixture-key"}); err != nil {
		t.Fatal(err)
	}
	_, active := addTestConversation(t, s, child)
	if err := s.Send("Hold this folder"); err != nil {
		t.Fatal(err)
	}
	waitState(t, s, func(st State) bool { return countText(st.Messages, "Waiting") == 1 })
	workspace, _ := addTestConversation(t, s, alias)
	if err := s.Send("Must not overlap the child folder"); err == nil {
		t.Error("case alias of an occupied ancestor ran concurrently")
	}
	if err := s.RemoveWorkspace(workspace.ID, 1); err == nil {
		t.Error("case alias of an occupied ancestor was removed")
	}
	if err := s.AbortConversation(active.ID); err != nil {
		t.Fatal(err)
	}
}
