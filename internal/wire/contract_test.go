package wire

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRequestMismatchFailsBeforeDecode(t *testing.T) {
	called := false
	err := Decode("/api/open", func(any) error { called = true; return nil }, &PathInput{})
	if err == nil || called {
		t.Fatalf("mismatched request decoded: called=%v, err=%v", called, err)
	}
}

func TestRequestPreservesStrictDecoding(t *testing.T) {
	var in IDInput
	decoder := json.NewDecoder(strings.NewReader(`{"id":"conversation","extra":true}`))
	decoder.DisallowUnknownFields()
	if err := Decode("/api/open", decoder.Decode, &in); err == nil {
		t.Fatal("unknown JSON field accepted")
	}
}

func TestResponseMismatchFailsClosed(t *testing.T) {
	recorder := httptest.NewRecorder()
	WriteJSON(recorder, "POST", "/api/open", PathResponse{Path: "wrong"})
	if recorder.Code != 500 || strings.Contains(recorder.Body.String(), "wrong") {
		t.Fatalf("mismatched response escaped: %d %s", recorder.Code, recorder.Body.String())
	}
	valid := httptest.NewRecorder()
	WriteJSON(valid, "POST", "/api/open", OKResponse{OK: true})
	if valid.Code != 200 || !strings.Contains(valid.Body.String(), `"ok":true`) {
		t.Fatalf("valid response rejected: %d %s", valid.Code, valid.Body.String())
	}
}

func TestQueryNamesAndNumbersComeFromDTO(t *testing.T) {
	req := httptest.NewRequest("GET", "/api/image?id=chat&message=image&index=2", nil)
	query, err := ReadQuery[ImageQuery](req)
	if err != nil || query != (ImageQuery{ID: "chat", Message: "image", Index: 2}) {
		t.Fatalf("query = %#v, err = %v", query, err)
	}
	if _, err = ReadQuery[IDInput](req); err == nil {
		t.Fatal("mismatched query type accepted")
	}
	if _, err = ReadQuery[ImageQuery](httptest.NewRequest("GET", "/api/image?id=chat&index=invalid", nil)); err == nil {
		t.Fatal("invalid numeric query accepted")
	}
}
