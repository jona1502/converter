package jobs

import (
	"reflect"
	"strings"
	"testing"
)

func TestParsePageSelection(t *testing.T) {
	cases := []struct {
		in   string
		all  bool
		want []int
	}{
		{"all", true, nil},
		{"1", false, []int{1}},
		{"3,1,2", false, []int{1, 2, 3}},
		{"1-3,2-5", false, []int{1, 2, 3, 4, 5}},
		{"7,7,7", false, []int{7}},
		{"10-10", false, []int{10}},
		{"9999", false, []int{9999}},
	}
	for _, tc := range cases {
		pages, all, err := ParsePageSelection(tc.in)
		if err != nil || all != tc.all || !reflect.DeepEqual(pages, tc.want) {
			t.Errorf("ParsePageSelection(%q) = %v, %v, %v", tc.in, pages, all, err)
		}
	}
}

func TestParsePageSelectionRejectsMalformedInput(t *testing.T) {
	for _, in := range []string{"", " ", "0", "-1", "1-", "-", "1--2", "3-2", "1,,2", "1,", ",1", "1 2", "1, 2",
		"٣", "10000", "1e3", "ALL", "all,1", strings.Repeat("1", 201), "0-3", "1-10000"} {
		if _, _, err := ParsePageSelection(in); err == nil {
			t.Errorf("ParsePageSelection(%q) muss abgelehnt werden", in)
		}
	}
}

func TestNormalizePagesIsCanonicalAndRoundTrips(t *testing.T) {
	cases := map[string][]int{
		"1":         {1},
		"1-3,5":     {1, 2, 3, 5},
		"1,3,5":     {1, 3, 5},
		"4-5":       {4, 5},
		"1-2,4-6,9": {1, 2, 4, 5, 6, 9},
	}
	for want, pages := range cases {
		if got := NormalizePages(pages); got != want {
			t.Errorf("NormalizePages(%v) = %q, erwartet %q", pages, got, want)
		}
		back, _, err := ParsePageSelection(want)
		if err != nil || !reflect.DeepEqual(back, pages) {
			t.Errorf("Rundreise %q = %v, %v", want, back, err)
		}
	}
}

func TestPdfImageNamesAndContainer(t *testing.T) {
	if got := PdfImageDownloadName("Mein Bericht.PDF", "jpeg", 3); got != "Mein Bericht-seite-3.jpg" {
		t.Errorf("Bildname = %q", got)
	}
	if got := PdfImageDownloadName("../x:y.pdf", "png", 12); got != "_x_y-seite-12.png" {
		t.Errorf("bereinigter Bildname = %q", got)
	}
	if got := PdfImageArchiveName("Mein Bericht.pdf"); got != "Mein Bericht-bilder.zip" {
		t.Errorf("Archivname = %q", got)
	}
	if got := PdfImageArchiveName(""); got != "dokument-bilder.zip" {
		t.Errorf("Archivname ohne Namen = %q", got)
	}
	rows, err := Upload{Tool: "pdf-to-image", OutputFormat: "webp", PDFPage: 2}.resultRows("a.pdf")
	if err != nil || len(rows) != 1 || rows[0].mime != "image/webp" || rows[0].name != "a-seite-2.webp" || rows[0].level != nil {
		t.Errorf("Einzelbild-Zeile = %+v, %v", rows, err)
	}
	rows, err = Upload{Tool: "pdf-to-image", OutputFormat: "png", PDFArchive: true}.resultRows("a.pdf")
	if err != nil || len(rows) != 1 || rows[0].mime != "application/zip" || rows[0].name != "a-bilder.zip" {
		t.Errorf("Archiv-Zeile = %+v, %v", rows, err)
	}
	if _, err = (Upload{Tool: "pdf-to-image", OutputFormat: "gif"}).resultRows("a.pdf"); err == nil {
		t.Error("unbekanntes Zielformat muss scheitern")
	}
	if _, err = (Upload{Tool: "pdf-to-image", OutputFormat: "png", PDFPage: 0}).resultRows("a.pdf"); err == nil {
		t.Error("Einzelbild ohne Seite muss scheitern")
	}
}
