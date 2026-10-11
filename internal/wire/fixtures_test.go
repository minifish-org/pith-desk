package wire

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/minifish-org/pith-desk/internal/desk"
)

func fixtureJSON(t *testing.T, data []byte) any {
	t.Helper()
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func TestFixedEndpointManifest(t *testing.T) {
	fixed, err := os.ReadFile("testdata/endpoints.txt")
	if err != nil {
		t.Fatal(err)
	}
	want := strings.Split(strings.TrimSpace(string(fixed)), "\n")
	var got []string
	for _, endpoint := range Endpoints {
		got = append(got, fmt.Sprintf("%s %s %s", endpoint.Method, endpoint.Format, endpoint.Path))
	}
	// Route registration order is private; method, path and format are public.
	sort.Strings(got)
	sort.Strings(want)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("public endpoints changed; review compatibility before updating the fixed manifest:\ngot %v\nwant %v", got, want)
	}
}

func TestFixedRequestFixtures(t *testing.T) {
	fixed, err := os.ReadFile("testdata/requests.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Method, Format, Path, URL string
		Input                     json.RawMessage
	}
	if err := json.Unmarshal(fixed, &cases); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run(tc.Method+" "+tc.Path, func(t *testing.T) {
			var registered *Endpoint
			for i := range Endpoints {
				if Endpoints[i].Method == tc.Method && Endpoints[i].Path == tc.Path {
					registered = &Endpoints[i]
					break
				}
			}
			if registered == nil || registered.Format != tc.Format {
				t.Fatal("fixed request is no longer registered with its original format")
			}
			typ := registered.Input
			if tc.Method == "GET" {
				typ = registered.Query
			}
			value := reflect.New(typ).Interface()
			decoder := json.NewDecoder(bytes.NewReader(tc.Input))
			decoder.DisallowUnknownFields()
			if tc.Method == "POST" {
				err = Decode(tc.Path, decoder.Decode, value)
			} else {
				err = decoder.Decode(value)
				// Check fixed URL names/values independently of JSON decoding.
				request := httptest.NewRequest("GET", tc.URL, nil)
				query := request.URL.Query()
				fields := reflect.ValueOf(value).Elem()
				for i := 0; i < typ.NumField(); i++ {
					name := strings.Split(typ.Field(i).Tag.Get("json"), ",")[0]
					if query.Get(name) != fmt.Sprint(fields.Field(i).Interface()) {
						t.Fatalf("fixed query field %s no longer agrees with its JSON input", name)
					}
				}
				if tc.Path == "/api/image" {
					decoded, queryErr := ReadQuery[ImageQuery](request)
					if queryErr != nil || !reflect.DeepEqual(&decoded, value) {
						t.Fatalf("fixed image query changed: %#v, %v", decoded, queryErr)
					}
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			encoded, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(fixtureJSON(t, encoded), fixtureJSON(t, tc.Input)) {
				t.Fatalf("fixed request changed after decoding/encoding: %s", encoded)
			}
		})
	}
}

func TestFixedStateHTTPAndStreamContracts(t *testing.T) {
	for _, name := range []string{"empty", "active", "idle"} {
		t.Run(name, func(t *testing.T) {
			fixed, err := os.ReadFile("../desk/testdata/state." + name + ".json")
			if err != nil {
				t.Fatal(err)
			}
			var state desk.State
			decoder := json.NewDecoder(bytes.NewReader(fixed))
			decoder.DisallowUnknownFields()
			if err := decoder.Decode(&state); err != nil {
				t.Fatal(err)
			}
			recorder := httptest.NewRecorder()
			WriteJSON(recorder, "GET", "/api/state", state)
			if recorder.Code != 200 || !reflect.DeepEqual(fixtureJSON(t, recorder.Body.Bytes()), fixtureJSON(t, fixed)) {
				t.Fatalf("fixed HTTP State changed: %d %s", recorder.Code, recorder.Body.String())
			}
			for _, path := range []string{"/api/socket", "/api/events"} {
				found := false
				for _, endpoint := range Endpoints {
					if endpoint.Method == "GET" && endpoint.Path == path && endpoint.Format == "stream" && endpoint.Output == reflect.TypeFor[desk.State]() {
						found = true
					}
				}
				if !found {
					t.Fatalf("%s no longer uses the HTTP State contract", path)
				}
			}
		})
	}
}
