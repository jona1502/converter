package jobs

import (
	"encoding/json"
	"testing"
)

func TestSplitResultRowNamesAndMIME(t *testing.T) {
	for _, tc := range []struct{ name, options, wantName, wantMIME string }{
		{"Bericht.pdf", `{"mode":"each","tool":"pdf-split"}`, "Bericht-geteilt.zip", ZIPMIME},
		{"Bericht.pdf", `{"mode":"ranges","ranges":"1-3,5","tool":"pdf-split"}`, "Bericht-geteilt.zip", ZIPMIME},
		{"Bericht.pdf", `{"mode":"ranges","ranges":"1,1","tool":"pdf-split"}`, "Bericht-geteilt.zip", ZIPMIME},
		{"Bericht.pdf", `{"mode":"ranges","ranges":"5","tool":"pdf-split"}`, "Bericht-seite-5.pdf", PDFMIME},
		{"Bericht.pdf", `{"mode":"ranges","ranges":"2-4","tool":"pdf-split"}`, "Bericht-seiten-2-4.pdf", PDFMIME},
		{"Bericht.pdf", `{"mode":"ranges","ranges":"2-2","tool":"pdf-split"}`, "Bericht-seite-2.pdf", PDFMIME},
		{"Bericht.pdf", `{"mode":"ranges","ranges":"7-","tool":"pdf-split"}`, "Bericht-seiten-7-ende.pdf", PDFMIME},
		{"a/b:c.pdf", `{"mode":"each","tool":"pdf-split"}`, "a_b_c-geteilt.zip", ZIPMIME},
		{"con.pdf", `{"mode":"ranges","ranges":"1","tool":"pdf-split"}`, "_con-seite-1.pdf", PDFMIME},
		{"", `{"mode":"each","tool":"pdf-split"}`, "dokument-geteilt.zip", ZIPMIME},
	} {
		row, err := splitResultRow(tc.name, json.RawMessage(tc.options))
		if err != nil || row.name != tc.wantName || row.mime != tc.wantMIME || row.level != nil || row.ordinal != 0 {
			t.Errorf("%s %s: %+v %v", tc.name, tc.options, row, err)
		}
	}
}

func TestSplitResultRowRejectsBrokenOptions(t *testing.T) {
	for _, raw := range []string{`{}`, `{"mode":"all"}`, `{"mode":"ranges","ranges":"x"}`, `{"mode":"ranges"}`, `nope`} {
		if row, err := splitResultRow("a.pdf", json.RawMessage(raw)); err == nil {
			t.Errorf("%s akzeptiert: %+v", raw, row)
		}
	}
}
