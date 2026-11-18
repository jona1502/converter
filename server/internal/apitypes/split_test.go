package apitypes_test

import (
	"testing"

	"miconverter/server/internal/apitypes"
	"miconverter/server/internal/validation"
)

func decodeJobOptions(t *testing.T, raw string) (apitypes.JobOptions, error) {
	t.Helper()
	var out apitypes.JobOptions
	err := validation.DecodeStrictBytes([]byte(raw), validation.Limits{MaxBytes: 8192}, "options", &out)
	return out, err
}

func TestSplitOptionsDecodeIntoUnion(t *testing.T) {
	out, err := decodeJobOptions(t, `{"tool":"pdf-split","mode":"ranges","ranges":"1-3,5"}`)
	if err != nil {
		t.Fatal(err)
	}
	split, ok := out.Value.(*apitypes.SplitOptions)
	if !ok || split.Mode != apitypes.SplitModeRanges || split.Ranges.Or("") != "1-3,5" {
		t.Fatalf("%#v", out.Value)
	}
	out, err = decodeJobOptions(t, `{"tool":"pdf-split","mode":"each"}`)
	if err != nil {
		t.Fatal(err)
	}
	if split = out.Value.(*apitypes.SplitOptions); split.Ranges.Or("x") != "x" {
		t.Fatal("ranges muss fehlen")
	}
}

func TestSplitOptionsRejectUnknownFieldsAndNull(t *testing.T) {
	for _, raw := range []string{
		`{"tool":"pdf-split"}`,
		`{"tool":"pdf-split","mode":"each","levels":["high"]}`,
		`{"tool":"pdf-split","mode":"ranges","ranges":null}`,
		`{"tool":"pdf-split","mode":3}`,
	} {
		if _, err := decodeJobOptions(t, raw); err == nil {
			t.Fatalf("akzeptiert: %s", raw)
		}
	}
}

func TestSplitEnumsAndCodesAreRegistered(t *testing.T) {
	found := false
	for _, tool := range apitypes.Tools() {
		found = found || tool == apitypes.ToolPDFSplit
	}
	if !found {
		t.Fatal("pdf-split fehlt in Tools()")
	}
	found = false
	for _, code := range apitypes.ProcessingErrorCodes() {
		found = found || code == apitypes.ProcPageRangeInvalid
	}
	if !found {
		t.Fatal("page-range-invalid fehlt in ProcessingErrorCodes()")
	}
}
