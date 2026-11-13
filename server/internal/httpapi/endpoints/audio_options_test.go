package endpoints

import (
	"errors"
	"testing"

	"miconverter/server/internal/apitypes"
	"miconverter/server/internal/httpapi"
)

func TestAudioOptionsAreCanonicalWithDefaults(t *testing.T) {
	cases := map[string]string{
		`{"tool":"audio-convert","format":"mp3"}`:                                   `{"channels":"original","format":"mp3","quality":0.8,"tool":"audio-convert"}`,
		`{"format":"flac","tool":"audio-convert","channels":"mono","quality":0}`:    `{"channels":"mono","format":"flac","quality":0.0,"tool":"audio-convert"}`,
		`{"tool":"audio-convert","format":"ogg","quality":1,"channels":"original"}`: `{"channels":"original","format":"ogg","quality":1.0,"tool":"audio-convert"}`,
		`{"tool":"audio-convert","format":"wav","quality":0.25,"channels":"mono"}`:  `{"channels":"mono","format":"wav","quality":0.25,"tool":"audio-convert"}`,
	}
	for input, want := range cases {
		got, err := parseOptions([]byte(input))
		if err != nil {
			t.Fatalf("%s: %v", input, err)
		}
		if string(got.canonical) != want || got.tool != "audio-convert" {
			t.Errorf("%s:\n%s\n%s", input, got.canonical, want)
		}
	}
	got, _ := parseOptions([]byte(`{"tool":"audio-convert","format":"ogg"}`))
	if got.format != "ogg" {
		t.Errorf("format = %q", got.format)
	}
}

func TestAudioOptionsRejectInvalidValues(t *testing.T) {
	cases := map[string]apitypes.ApiErrorCode{
		`{"tool":"audio-convert"}`:                                         apitypes.CodeInvalidRequest,
		`{"tool":"audio-convert","format":"m4a"}`:                          apitypes.CodeInvalidOptions,
		`{"tool":"audio-convert","format":"original"}`:                     apitypes.CodeInvalidOptions,
		`{"tool":"audio-convert","format":"mp3","quality":1.01}`:           apitypes.CodeInvalidOptions,
		`{"tool":"audio-convert","format":"mp3","quality":-0.1}`:           apitypes.CodeInvalidOptions,
		`{"tool":"audio-convert","format":"mp3","quality":null}`:           apitypes.CodeInvalidRequest,
		`{"tool":"audio-convert","format":"mp3","quality":"0.5"}`:          apitypes.CodeInvalidRequest,
		`{"tool":"audio-convert","format":"mp3","channels":"stereo"}`:      apitypes.CodeInvalidOptions,
		`{"tool":"audio-convert","format":"mp3","channels":null}`:          apitypes.CodeInvalidRequest,
		`{"tool":"audio-convert","format":"mp3","resize":{"mode":"none"}}`: apitypes.CodeInvalidRequest,
		`{"tool":"audio-convert","format":"mp3","levels":["high"]}`:        apitypes.CodeInvalidRequest,
	}
	for input, want := range cases {
		_, err := parseOptions([]byte(input))
		var api *httpapi.Error
		if !errors.As(err, &api) || api.Code != want || api.Status != 422 {
			t.Errorf("%s: %v, erwartet %s", input, err, want)
		}
	}
}
