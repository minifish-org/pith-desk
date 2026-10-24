package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/minifish-org/pith-desk/internal/wire"
)

type contractFixtureEmbedded struct {
	Label string `json:"label"`
}
type contractFixture struct {
	contractFixtureEmbedded
	Optional      *int            `json:"optional,omitempty"`
	Required      *int            `json:"required"`
	Items         []string        `json:"items"`
	OptionalItems []string        `json:"optionalItems,omitempty"`
	Raw           json.RawMessage `json:"raw"`
	Hidden        string          `json:"-"`
}

func TestJSONSemanticsAreGenerated(t *testing.T) {
	// Pointers, omission, nil slices, raw JSON and flattened embedded fields
	// have different JSON semantics; preserve them across the language boundary.
	data, err := generate([]wire.Endpoint{{Method: "GET", Path: "/api/fixture", Query: reflect.TypeFor[wire.EmptyInput](), Output: reflect.TypeFor[contractFixture](), Format: "json"}})
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, required := range []string{"label: string", "optional?: number", "required: number | null", "items: (string)[] | null", "optionalItems?: (string)[]", "raw: unknown"} {
		if !strings.Contains(text, required) {
			t.Errorf("missing %q in generated contract", required)
		}
	}
	if strings.Contains(text, "hidden:") {
		t.Fatal("json:- field was exported")
	}
}

func writeHandler(t *testing.T, source string) string {
	t.Helper()
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "server.go"), []byte(source), 0644); err != nil {
		t.Fatal(err)
	}
	return directory
}

func TestUnregisteredHandlerFailsDriftCheck(t *testing.T) {
	directory := writeHandler(t, `package host
func serveFeatureMutation() { switch path { case "/api/unregistered": } }`)
	if err := verifyHandlers(directory, nil); err == nil || !strings.Contains(err.Error(), "unregistered") {
		t.Fatalf("got %v", err)
	}
}

func TestChangedDecoderFailsDriftCheck(t *testing.T) {
	endpoints := []wire.Endpoint{{Method: "POST", Path: "/api/open", Input: reflect.TypeFor[wire.IDInput](), Format: "json"}}
	for _, name := range []string{"in", "input"} {
		t.Run(name, func(t *testing.T) {
			directory := writeHandler(t, `package host
func serveFeatureMutation() { switch path { case "/api/open": var `+name+` wire.PathInput; _ = wire.Decode(path, decode, &`+name+`) } }`)
			if err := verifyHandlers(directory, endpoints); err == nil || !strings.Contains(err.Error(), "request type drift") {
				t.Fatalf("got %v", err)
			}
		})
	}
}

func TestHandlerNamesDoNotChangeTheirContracts(t *testing.T) {
	directory := writeHandler(t, `package host
import nethttp "net/http"
func renamedRouter() {
  if req.URL.Path == "/api/state" && nethttp.MethodGet == req.Method { return }
}
func renamedReads() {
  if nethttp.MethodGet != r.Method { return }
  switch r.URL.Path { case "/api/history": wire.ReadQuery[wire.IDInput](r) }
}
func renamedWrites() {
  if "POST" != r.Method { return }
  switch r.URL.Path { case "/api/open": var input wire.IDInput; _ = wire.Decode(r.URL.Path, decode, &input) }
}`)
	endpoints := []wire.Endpoint{
		{Method: "GET", Path: "/api/state", Query: reflect.TypeFor[wire.EmptyInput](), Format: "json"},
		{Method: "GET", Path: "/api/history", Query: reflect.TypeFor[wire.IDInput](), Format: "json"},
		{Method: "POST", Path: "/api/open", Input: reflect.TypeFor[wire.IDInput](), Format: "json"},
	}
	if err := verifyHandlers(directory, endpoints); err != nil {
		t.Fatal(err)
	}
}

func TestDecoderChecksItsArgumentInsteadOfAnotherLocal(t *testing.T) {
	for _, delegated := range []bool{false, true} {
		for _, typ := range []string{"IDInput", "PathInput"} {
			for _, form := range []struct{ declaration, argument string }{
				{`var input wire.TYPE`, `&input`},
				{`input := wire.TYPE{}`, `&input`},
				{``, `&wire.TYPE{}`},
				{`var input *wire.TYPE`, `input`},
				{`input := new(wire.TYPE)`, `input`},
				{`input := &wire.TYPE{}`, `input`},
				{``, `new(wire.TYPE)`},
			} {
				body := strings.ReplaceAll(`var in wire.PathInput; _ = in; `+form.declaration+`; _ = wire.Decode(r.URL.Path, decode, `+form.argument+`)`, "TYPE", typ)
				if delegated {
					body = strings.ReplaceAll(body, "r.URL.Path", `"/api/open"`)
					body = `switch r.URL.Path { case "/api/open": delegated() }; ` + body
				} else {
					body = `switch r.URL.Path { case "/api/open": ` + body + ` }`
				}
				directory := writeHandler(t, `package host
func dispatch() { if r.Method != http.MethodPost { return }; `+body+` }`)
				endpoints := []wire.Endpoint{{Method: "POST", Path: "/api/open", Input: reflect.TypeFor[wire.IDInput](), Format: "json"}}
				err := verifyHandlers(directory, endpoints)
				if typ == "IDInput" && err != nil || typ != "IDInput" && (err == nil || !strings.Contains(err.Error(), "request type drift")) {
					t.Fatalf("delegated=%t type=%s form=%+v: %v", delegated, typ, form, err)
				}
			}
		}
	}
}

func TestRemovedHandlerFailsDriftCheck(t *testing.T) {
	directory := writeHandler(t, "package host")
	endpoints := []wire.Endpoint{{Method: "POST", Path: "/api/open", Input: reflect.TypeFor[wire.IDInput](), Format: "json"}}
	if err := verifyHandlers(directory, endpoints); err == nil || !strings.Contains(err.Error(), "no host route") {
		t.Fatalf("got %v", err)
	}
}

func TestChangedQueryFailsDriftCheck(t *testing.T) {
	directory := writeHandler(t, `package host
func serveFeatureRead() { if r.Method != http.MethodGet { return }; switch path { case "/api/history": wire.ReadQuery[wire.WorkspaceInput](r) } }`)
	endpoints := []wire.Endpoint{{Method: "GET", Path: "/api/history", Query: reflect.TypeFor[wire.IDInput](), Format: "json"}}
	if err := verifyHandlers(directory, endpoints); err == nil || !strings.Contains(err.Error(), "query type drift") {
		t.Fatalf("got %v", err)
	}
}

func TestRemovingReadOfSharedPathFailsDriftCheck(t *testing.T) {
	directory := writeHandler(t, `package host
func serveFeatureMutation() { switch path { case "/api/custom-connection": var in wire.IDInput; _ = in } }`)
	endpoints := []wire.Endpoint{
		{Method: "GET", Path: "/api/custom-connection", Query: reflect.TypeFor[wire.IDInput](), Format: "json"},
		{Method: "POST", Path: "/api/custom-connection", Input: reflect.TypeFor[wire.IDInput](), Format: "json"},
	}
	if err := verifyHandlers(directory, endpoints); err == nil || !strings.Contains(err.Error(), "GET /api/custom-connection") {
		t.Fatalf("got %v", err)
	}
}
