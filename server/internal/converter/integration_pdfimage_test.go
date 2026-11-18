package converter

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image/png"
	"os"
	"testing"
	"time"
)

// threePagePDF baut eine kleine gültige PDF (3 Seiten à 200 x 100 pt, jede mit
// eigener Füllfarbe) mit korrekter Querverweistabelle.
func threePagePDF() []byte {
	var out bytes.Buffer
	offsets := []int{}
	object := func(body string) {
		offsets = append(offsets, out.Len())
		fmt.Fprintf(&out, "%d 0 obj\n%s\nendobj\n", len(offsets), body)
	}
	out.WriteString("%PDF-1.4\n")
	object("<< /Type /Catalog /Pages 2 0 R >>")
	object("<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>")
	for i, color := range []string{"1 0 0", "0 1 0", "0 0 1"} {
		page, content := 3+2*i, 4+2*i
		object(fmt.Sprintf("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents %d 0 R >>", content))
		stream := fmt.Sprintf("%s rg 0 0 200 100 re f", color)
		object(fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(stream), stream))
		_ = page
	}
	xref := out.Len()
	fmt.Fprintf(&out, "xref\n0 %d\n0000000000 65535 f \n", len(offsets)+1)
	for _, offset := range offsets {
		fmt.Fprintf(&out, "%010d 00000 n \n", offset)
	}
	fmt.Fprintf(&out, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(offsets)+1, xref)
	return out.Bytes()
}

func TestRealPythonPdfImagePipeline(t *testing.T) {
	r := realRunner(t)
	report, err := r.Probe(context.Background())
	if err != nil || !report.PdfImage.Available {
		t.Fatalf("probe=%+v err=%v", report, err)
	}
	for _, tc := range []struct {
		name, options, code string
		wantDetails         string
		archive             bool
	}{
		{"archive", `{"tool":"pdf-to-image","format":"png","dpi":72,"pages":"1-2","quality":0.85}`, "",
			`{"pageCount":2,"sourcePageCount":3,"archive":true}`, true},
		{"single", `{"tool":"pdf-to-image","format":"png","dpi":144,"pages":"2","quality":0.85}`, "",
			`{"pageCount":1,"sourcePageCount":3,"archive":false}`, false},
		{"outside", `{"tool":"pdf-to-image","format":"png","dpi":72,"pages":"4","quality":0.85}`, "parse-failed", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := requestFor(t)
			req.Options = json.RawMessage(tc.options)
			req.Timeout = 60 * time.Second
			if err := os.WriteFile(req.Source, threePagePDF(), 0o600); err != nil {
				t.Fatal(err)
			}
			var code string
			var details json.RawMessage
			progress := 0
			out, err := r.Run(context.Background(), req, func(e Event) error {
				switch e.Kind {
				case KindResult:
					details = e.Details
				case KindError:
					code = e.Code
				case KindProgress:
					if e.Progress != nil {
						progress++
					}
				}
				return nil
			})
			if err != nil || out.ErrorCode != "" || code != tc.code {
				t.Fatalf("out=%+v code=%q err=%v", out, code, err)
			}
			data, err := os.ReadFile(req.Results[0].Path)
			if err != nil {
				t.Fatal(err)
			}
			if tc.code != "" {
				if len(data) != 0 {
					t.Fatalf("fehlgeschlagene Ausgabe hat %d Bytes", len(data))
				}
				return
			}
			if string(details) != tc.wantDetails || progress == 0 {
				t.Fatalf("details=%s progress=%d", details, progress)
			}
			if tc.archive {
				archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
				if err != nil || len(archive.File) != 2 || archive.File[0].Name != "seite-001.png" || archive.File[1].Name != "seite-002.png" {
					t.Fatalf("Archiv: %v %v", archive, err)
				}
				data = nil
				file, _ := archive.File[0].Open()
				cfg, err := png.DecodeConfig(file)
				_ = file.Close()
				if err != nil || cfg.Width != 200 || cfg.Height != 100 {
					t.Fatalf("PNG im Archiv: %+v %v", cfg, err)
				}
				return
			}
			cfg, err := png.DecodeConfig(bytes.NewReader(data))
			if err != nil || cfg.Width != 400 || cfg.Height != 200 {
				t.Fatalf("PNG: %+v %v", cfg, err)
			}
		})
	}
}
