package endpoints

import (
	"errors"
	"strings"
	"testing"

	"miconverter/server/internal/httpapi"
)

func TestSplitOptionsCanonical(t *testing.T) {
	cases := map[string]string{
		`{"tool":"pdf-split","mode":"each"}`:                       `{"mode":"each","tool":"pdf-split"}`,
		`{"tool":"pdf-split","mode":"ranges","ranges":"1-3,5,7-"}`: `{"mode":"ranges","ranges":"1-3,5,7-","tool":"pdf-split"}`,
		`{"ranges":"2","mode":"ranges","tool":"pdf-split"}`:        `{"mode":"ranges","ranges":"2","tool":"pdf-split"}`,
	}
	for raw, want := range cases {
		o, err := parseOptions([]byte(raw))
		if err != nil || o.tool != "pdf-split" || o.format != "pdf" || string(o.canonical) != want {
			t.Fatalf("%s: %+v %v", raw, o, err)
		}
	}
}

func TestSplitOptionsRejectInvalid(t *testing.T) {
	for _, raw := range []string{
		`{"tool":"pdf-split"}`,
		`{"tool":"pdf-split","mode":"all"}`,
		`{"tool":"pdf-split","mode":"ranges"}`,
		`{"tool":"pdf-split","mode":"ranges","ranges":null}`,
		`{"tool":"pdf-split","mode":"ranges","ranges":""}`,
		`{"tool":"pdf-split","mode":"ranges","ranges":"1, 2"}`,
		`{"tool":"pdf-split","mode":"ranges","ranges":"3-1"}`,
		`{"tool":"pdf-split","mode":"ranges","ranges":"0"}`,
		`{"tool":"pdf-split","mode":"ranges","ranges":"100000"}`,
		`{"tool":"pdf-split","mode":"ranges","ranges":7}`,
		`{"tool":"pdf-split","mode":"each","ranges":"1"}`,
		`{"tool":"pdf-split","mode":"each","ranges":null}`,
		`{"tool":"pdf-split","mode":"each","levels":["high"]}`,
		`{"tool":"pdf-split","mode":"ranges","ranges":"` + strings.Repeat("1,", 500) + `1"}`,
	} {
		if o, err := parseOptions([]byte(raw)); err == nil {
			t.Fatalf("akzeptiert: %s -> %+v", raw, o)
		}
	}
}

func TestSplitInvalidRangesUseInvalidOptionsCode(t *testing.T) {
	_, err := parseOptions([]byte(`{"tool":"pdf-split","mode":"ranges","ranges":"x"}`))
	var api *httpapi.Error
	if !errors.As(err, &api) || api.Status != 422 {
		t.Fatalf("%v", err)
	}
}
