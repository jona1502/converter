package endpoints

import (
	"testing"

	"miconverter/server/internal/apitypes"
)

func TestPdfMergeOptionsCanonical(t *testing.T) {
	o, err := parseOptions([]byte(`{"tool":"pdf-merge"}`))
	if err != nil || o.tool != "pdf-merge" || o.format != "pdf" || string(o.canonical) != `{"tool":"pdf-merge"}` {
		t.Fatalf("%+v %v", o, err)
	}
	if len(o.levels) != 0 {
		t.Fatalf("pdf-merge hat keine Stufen: %v", o.levels)
	}
}

func TestPdfMergeOptionsRejectUnknownAndWrongTypes(t *testing.T) {
	for _, raw := range []string{
		`{"tool":"pdf-merge","levels":["high"]}`, `{"tool":"pdf-merge","order":[1,0]}`,
		`{"tool":"pdf-merge","format":"pdf"}`, `{"tool":"pdf-merge","pageSize":"a4"}`,
		`{"tool":"pdf-merge","tool":"pdf-merge"}`, `{"tool":"pdf-merge",}`, `{"tool":null}`,
		`{"tool":"pdf-merge "}`, `{}`, `[]`,
	} {
		if _, err := parseOptions([]byte(raw)); err == nil {
			t.Errorf("%s akzeptiert", raw)
		}
	}
}

func TestPdfMergeIsListedAsTool(t *testing.T) {
	found := false
	for _, tool := range apitypes.Tools() {
		found = found || tool == apitypes.ToolPDFMerge
	}
	if !found {
		t.Fatal("pdf-merge fehlt in Tools()")
	}
}
