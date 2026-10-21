// Test-only process for Playwright: real Service, authenticated Host, SDK and
// isolated persistence. Control travels over stdin, never a production route.
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"github.com/minifish-org/pith-desk/internal/testsupport/shellfixture"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"

	"github.com/minifish-org/pith-desk/internal/desk"
	"github.com/minifish-org/pith-desk/internal/host"
)

func main() {
	root := flag.String("root", "", "isolated test directory")
	frontend := flag.String("frontend", "http://127.0.0.1:5197", "development frontend")
	uiSource := flag.String("ui-source", "", "explicit local UI source for development browser checks")
	desktop := flag.Bool("desktop", false, "exercise Desktop transport in a browser")
	flag.Parse()
	if *root == "" {
		panic("test root is required")
	}
	shell, err := shellfixture.Create(*root)
	if err != nil {
		panic(err)
	}
	if err := os.Setenv("SHELL", shell); err != nil {
		panic(err)
	}
	var requests, canceled atomic.Int32
	var lastRequest atomic.Value
	var hold atomic.Bool
	var writeTool atomic.Bool
	var commandTool atomic.Bool
	release := make(chan struct{}, 1)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture-provider-key" {
			http.Error(w, "invalid fixture credential", http.StatusUnauthorized)
			return
		}
		var body json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid fixture request", http.StatusBadRequest)
			return
		}
		lastRequest.Store(body)
		requests.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		if hold.Load() {
			select {
			case <-r.Context().Done():
				canceled.Add(1)
				return
			case <-release:
			}
		}
		write := func(value any) {
			data, _ := json.Marshal(value)
			_, _ = fmt.Fprintf(w, "data: %s\n\n", data)
			w.(http.Flusher).Flush()
		}
		if commandTool.Swap(false) {
			write(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"index": 0, "id": "fixture-command", "type": "function", "function": map[string]any{"name": "run_command", "arguments": `{"command":"pwd > agent-cwd.txt; printf '%s' \"${MANUAL_ONLY-unset}\" > agent-env.txt"}`}}}}}}})
			write(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{}, "finish_reason": "tool_calls"}}})
			fmt.Fprint(w, "data: [DONE]\n\n")
			return
		}
		if writeTool.Swap(false) {
			write(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"index": 0, "id": "fixture-write", "type": "function", "function": map[string]any{"name": "write_file", "arguments": `{"path":"approved.txt","content":"Approved on Server"}`}}}}}}})
			write(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{}, "finish_reason": "tool_calls"}}})
			fmt.Fprint(w, "data: [DONE]\n\n")
			return
		}
		write(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": "Fixture answer"}}}})
		write(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{}, "finish_reason": "stop"}}, "usage": map[string]any{"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}})
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
		w.(http.Flusher).Flush()
	}))
	defer provider.Close()
	dataDir := filepath.Join(*root, "private")
	var service *desk.Service
	var server *host.Server
	open := func() error {
		var err error
		service, err = desk.New(dataDir)
		if err != nil {
			return err
		}
		if len(service.Snapshot().Workspaces) == 0 {
			if err := service.Configure(desk.ConfigInput{BaseURL: provider.URL + "/v1", Model: "deepseek-flash", APIKey: "fixture-provider-key"}); err != nil {
				return err
			}
			var first string
			for _, name := range []string{"Workspace A", "Workspace B"} {
				folder := filepath.Join(*root, name)
				if err := os.MkdirAll(folder, 0700); err != nil {
					return err
				}
				if err := os.WriteFile(filepath.Join(folder, "report.txt"), []byte("Fixture download 中文\n"), 0600); err != nil {
					return err
				}
				workspace, err := service.AddWorkspace(folder)
				if err != nil {
					return err
				}
				conversation, err := service.CreateConversation(workspace.ID)
				if err != nil {
					return err
				}
				if err := service.RenameConversation(conversation.ID, name+" conversation"); err != nil {
					return err
				}
				if first == "" {
					first = conversation.ID
				}
			}
			if err := service.OpenConversation(first); err != nil {
				return err
			}
		}
		if *desktop {
			server, err = host.StartDevelopment(service, nil, host.DevelopmentOptions{URL: *frontend, UIRoot: *uiSource})
		} else {
			server, err = host.StartServer(service, host.ServerOptions{Listen: "127.0.0.1:0", FrontendURL: *frontend, FrontendUIRoot: *uiSource, Token: "fixture-server-token-0123456789abcdef"})
		}
		return err
	}
	closeHost := func() {
		if server != nil {
			_ = server.Close()
			server = nil
		}
		if service != nil {
			service.Close()
			service = nil
		}
	}
	defer closeHost()
	if err := open(); err != nil {
		panic(err)
	}
	output := json.NewEncoder(os.Stdout)
	respond := func(err error) {
		result := map[string]any{"requests": requests.Load(), "canceled": canceled.Load(), "lastRequest": lastRequest.Load()}
		if err != nil {
			result["error"] = err.Error()
		}
		if server != nil && service != nil {
			result["url"] = server.URL
			result["state"] = service.Snapshot()
			result["token"] = "fixture-server-token-0123456789abcdef"
		}
		_ = output.Encode(result)
	}
	respond(nil)
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var command struct {
			Action  string `json:"action"`
			ID      string `json:"id"`
			Title   string `json:"title"`
			Enabled bool   `json:"enabled"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &command); err != nil {
			respond(err)
			continue
		}
		var err error
		switch command.Action {
		case "state", "stats":
		case "rename":
			err = service.RenameConversation(command.ID, command.Title)
		case "hold-provider":
			hold.Store(command.Enabled)
			if !command.Enabled {
				select {
				case release <- struct{}{}:
				default:
				}
			}
		case "write-tool":
			writeTool.Store(command.Enabled)
		case "command-tool":
			commandTool.Store(command.Enabled)
		case "restart":
			closeHost()
			err = open()
		case "quit":
			return
		default:
			err = fmt.Errorf("unknown fixture command %q", command.Action)
		}
		respond(err)
	}
}
