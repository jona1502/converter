package endpoints

import (
	"strings"
	"testing"
)

func TestPdfRotateOptionsCanonicalDefaults(t *testing.T) {
	for raw, want := range map[string]string{
		`{"tool":"pdf-rotate","angle":90}`:                    `{"angle":90,"pages":"all","tool":"pdf-rotate"}`,
		`{"tool":"pdf-rotate","angle":270,"pages":"all"}`:     `{"angle":270,"pages":"all","tool":"pdf-rotate"}`,
		`{"tool":"pdf-rotate","angle":180,"pages":"1-3,5,9"}`: `{"angle":180,"pages":"1-3,5,9","tool":"pdf-rotate"}`,
		`{"tool":"pdf-rotate","angle":90,"pages":"7"}`:        `{"angle":90,"pages":"7","tool":"pdf-rotate"}`,
	} {
		o, err := parseOptions([]byte(raw))
		if err != nil || o.tool != "pdf-rotate" || o.format != "pdf" || string(o.canonical) != want {
			t.Errorf("%s: %+v %v", raw, o, err)
		}
	}
}

func TestPdfRotateOptionsRejectInvalid(t *testing.T) {
	for _, raw := range []string{
		`{"tool":"pdf-rotate"}`,
		`{"tool":"pdf-rotate","angle":0}`,
		`{"tool":"pdf-rotate","angle":45}`,
		`{"tool":"pdf-rotate","angle":-90}`,
		`{"tool":"pdf-rotate","angle":360}`,
		`{"tool":"pdf-rotate","angle":90.5}`,
		`{"tool":"pdf-rotate","angle":"90"}`,
		`{"tool":"pdf-rotate","angle":null}`,
		`{"tool":"pdf-rotate","angle":90,"pages":null}`,
		`{"tool":"pdf-rotate","angle":90,"pages":""}`,
		`{"tool":"pdf-rotate","angle":90,"pages":"0"}`,
		`{"tool":"pdf-rotate","angle":90,"pages":"01"}`,
		`{"tool":"pdf-rotate","angle":90,"pages":"3-1"}`,
		`{"tool":"pdf-rotate","angle":90,"pages":"1,,2"}`,
		`{"tool":"pdf-rotate","angle":90,"pages":"1, 2"}`,
		`{"tool":"pdf-rotate","angle":90,"pages":"-2"}`,
		`{"tool":"pdf-rotate","angle":90,"pages":"1-"}`,
		`{"tool":"pdf-rotate","angle":90,"pages":"1-2-3"}`,
		`{"tool":"pdf-rotate","angle":90,"pages":"ALL"}`,
		`{"tool":"pdf-rotate","angle":90,"pages":12345678}`,
		`{"tool":"pdf-rotate","angle":90,"pages":"12345678"}`,
		`{"tool":"pdf-rotate","angle":90,"pages":"` + strings.Repeat("1,", 200) + `1"}`,
		`{"tool":"pdf-rotate","angle":90,"levels":["high"]}`,
		`{"tool":"pdf-rotate","angle":90,"format":"png"}`,
	} {
		if _, err := parseOptions([]byte(raw)); err == nil {
			t.Errorf("%s: sollte abgelehnt werden", raw)
		}
	}
}
