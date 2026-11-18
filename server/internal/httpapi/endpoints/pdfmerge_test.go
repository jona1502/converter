package endpoints

import (
	"bytes"
	"errors"
	"io"
	"mime/multipart"
	"strings"
	"testing"

	"miconverter/server/internal/apitypes"
	"miconverter/server/internal/config"
	"miconverter/server/internal/converter"
	"miconverter/server/internal/httpapi"
	"miconverter/server/internal/jobs"
)

type testPart struct{ field, name, data string }

func mergeReader(t *testing.T, parts []testPart) *multipart.Reader {
	t.Helper()
	var b bytes.Buffer
	w := multipart.NewWriter(&b)
	for _, p := range parts {
		var dst io.Writer
		var err error
		if p.name == "" {
			dst, err = w.CreateFormField(p.field)
		} else {
			dst, err = w.CreateFormFile(p.field, p.name)
		}
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.WriteString(dst, p.data)
	}
	_ = w.Close()
	return multipart.NewReader(&b, w.Boundary())
}

func pdfPart(name, body string) testPart { return testPart{"file", name, "%PDF-1.7\n" + body} }

func apiCode(t *testing.T, err error) apitypes.ApiErrorCode {
	t.Helper()
	var api *httpapi.Error
	if !errors.As(err, &api) {
		t.Fatalf("kein API-Fehler: %v", err)
	}
	return api.Code
}

func TestMergePartsAreBundledInOrder(t *testing.T) {
	var sink bytes.Buffer
	up, err := readMergeParts(mergeReader(t, []testPart{pdfPart("b.pdf", "B"), pdfPart("a.pdf", "A"), pdfPart("c.pdf", "C")}), &sink, 1<<20, 1<<20)
	if err != nil || up.files != 3 || up.firstName != "b.pdf" || up.bundleSize != int64(sink.Len()) {
		t.Fatalf("%+v %v", up, err)
	}
	files, err := jobs.SplitBundle(sink.Bytes())
	if err != nil || len(files) != 3 {
		t.Fatalf("%d %v", len(files), err)
	}
	for i, want := range []string{"B", "A", "C"} {
		if !strings.HasSuffix(string(files[i]), want) {
			t.Errorf("Datei %d = %q", i, files[i])
		}
	}
	if up.payload != int64(len(files[0])+len(files[1])+len(files[2])) {
		t.Fatalf("payload %d", up.payload)
	}
}

func TestMergePartsRejectViolations(t *testing.T) {
	many := []testPart{}
	for range apitypes.PdfMergeMaxFiles + 1 {
		many = append(many, pdfPart("x.pdf", "x"))
	}
	exact := many[:apitypes.PdfMergeMaxFiles]
	cases := map[string]struct {
		parts []testPart
		code  apitypes.ApiErrorCode
	}{
		"keine Datei":    {nil, apitypes.CodeMissingFile},
		"eine Datei":     {[]testPart{pdfPart("a.pdf", "a")}, apitypes.CodeMissingFile},
		"zu viele":       {many, apitypes.CodeInvalidRequest},
		"falsches Feld":  {[]testPart{pdfPart("a.pdf", "a"), {"upload", "b.pdf", "%PDF-"}}, apitypes.CodeMissingFile},
		"ohne Dateiname": {[]testPart{pdfPart("a.pdf", "a"), {"file", "", "%PDF-"}}, apitypes.CodeMissingFile},
		"leere Datei":    {[]testPart{pdfPart("a.pdf", "a"), {"file", "b.pdf", ""}}, apitypes.CodeUnsupportedType},
		"kein PDF":       {[]testPart{pdfPart("a.pdf", "a"), {"file", "b.pdf", "GIF89a nope"}}, apitypes.CodeNotPDF},
		"zu groß":        {[]testPart{pdfPart("a.pdf", strings.Repeat("a", 600)), pdfPart("b.pdf", strings.Repeat("b", 600))}, apitypes.CodeFileTooLarge},
	}
	for name, tc := range cases {
		_, err := readMergeParts(mergeReader(t, tc.parts), io.Discard, 1000, 1<<20)
		if err == nil || apiCode(t, err) != tc.code {
			t.Errorf("%s: %v", name, err)
		}
	}
	if up, err := readMergeParts(mergeReader(t, exact), io.Discard, 1<<20, 1<<20); err != nil || up.files != apitypes.PdfMergeMaxFiles {
		t.Fatalf("genau am Limit: %+v %v", up, err)
	}
}

func TestMergeBundleLimitCountsFraming(t *testing.T) {
	parts := []testPart{pdfPart("a.pdf", strings.Repeat("a", 300)), pdfPart("b.pdf", strings.Repeat("b", 300))}
	var sink bytes.Buffer
	up, err := readMergeParts(mergeReader(t, parts), &sink, 1<<20, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	// Ein Byte unter der tatsächlichen Bündelgröße wird abgelehnt.
	if _, err = readMergeParts(mergeReader(t, parts), io.Discard, 1<<20, up.bundleSize-1); err == nil || apiCode(t, err) != apitypes.CodeFileTooLarge {
		t.Fatalf("Bündellimit: %v", err)
	}
	if mergeBundleLimit(100_000_000) < 100_000_000+1600 {
		t.Fatal("Rahmenreserve zu klein")
	}
}

func TestMergeCapabilitiesFromConfig(t *testing.T) {
	cfg, err := config.Load(func(k string) (string, bool) {
		if k == "CONVERTER_ENVIRONMENT" {
			return "test", true
		}
		return "", false
	})
	if err != nil {
		t.Fatal(err)
	}
	a := &API{cfg: cfg}
	got := a.mergeCapabilities(converter.Report{PDF: true})
	want := apitypes.PdfMergeCapabilities{Available: true, MinFiles: 2, MaxFiles: 20,
		MaxTotalBytes: cfg.PdfMaxInputBytes, MaxOutputBytes: cfg.PdfMaxInputBytes, MaxPages: 2000}
	if got != want {
		t.Fatalf("%+v", got)
	}
	if a.mergeCapabilities(converter.Report{}).Available {
		t.Fatal("ohne PDF-Probe nicht verfügbar")
	}
}
