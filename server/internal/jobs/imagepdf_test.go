package jobs

import "testing"

func TestImagePdfResultRow(t *testing.T) {
	for original, want := range map[string]string{
		"bilder.zip":      "bilder.pdf",
		"Urlaub 2026.zip": "Urlaub 2026.pdf",
		"../../etc/x.zip": "_.._etc_x.pdf",
		"":                "bilder.pdf",
		"a/b:c*.zip":      "a_b_c_.pdf",
		"con.zip":         "_con.pdf",
	} {
		rows, err := Upload{Tool: "image-pdf", InputFormat: "zip"}.resultRows(original)
		if err != nil || len(rows) != 1 {
			t.Fatalf("%q: %v %v", original, rows, err)
		}
		r := rows[0]
		if r.ordinal != 0 || r.level != nil || r.mime != PDFMIME || r.name != want {
			t.Errorf("%q: %+v, erwartet Name %q", original, r, want)
		}
	}
}

func TestImagePdfDisplayFallback(t *testing.T) {
	if got := DisplayName("", ImagePdfFallbackBase); got != "bilder" {
		t.Fatalf("%q", got)
	}
}
