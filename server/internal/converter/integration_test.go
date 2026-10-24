package converter

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	_ "image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"testing"
	"time"

	_ "golang.org/x/image/webp"
)

func realRunner(t *testing.T) *Runner {
	t.Helper()
	python := os.Getenv("CONVERTER_TEST_PYTHON")
	if python == "" {
		t.Skip("requires Linux converter runtime image and CONVERTER_TEST_PYTHON")
	}
	r := NewRunner()
	r.python = python
	return r
}

func TestRealPythonImagePipeline(t *testing.T) {
	r := realRunner(t)
	for _, tc := range []struct {
		name, options string
		width, height int
	}{
		{"convert", `{"tool":"image-convert","format":"webp"}`, 320, 200},
		{"compress", `{"tool":"image-compress","format":"jpeg","quality":0.5}`, 320, 200},
		{"resize", `{"tool":"image-resize","format":"png","resize":{"mode":"percent","percent":50,"allowUpscale":false}}`, 160, 100},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := requestFor(t)
			req.Options = json.RawMessage(tc.options)
			req.Timeout = 20 * time.Second
			img := image.NewNRGBA(image.Rect(0, 0, 320, 200))
			for y := range 200 {
				for x := range 320 {
					img.SetNRGBA(x, y, color.NRGBA{R: byte(x), G: byte(y), B: 80, A: 180})
				}
			}
			var buffer bytes.Buffer
			if err := png.Encode(&buffer, img); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(req.Source, buffer.Bytes(), 0600); err != nil {
				t.Fatal(err)
			}
			var size int64
			out, err := r.Run(context.Background(), req, func(event Event) error {
				if event.Kind == KindResult {
					size = event.Size
				}
				return nil
			})
			if err != nil || out.ErrorCode != "" || size == 0 {
				t.Fatalf("out=%+v err=%v", out, err)
			}
			file, err := os.Open(req.Results[0].Path)
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			decoded, _, err := image.Decode(file)
			if err != nil {
				t.Fatal(err)
			}
			if decoded.Bounds().Dx() != tc.width || decoded.Bounds().Dy() != tc.height {
				t.Fatalf("dimensions %v", decoded.Bounds())
			}
		})
	}
}

func minimalPDF() []byte {
	var buf bytes.Buffer
	buf.WriteString("%PDF-1.4\n")
	objects := []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>",
		"<< /Length 0 >>\nstream\n\nendstream",
	}
	offsets := []int{0}
	for i, obj := range objects {
		offsets = append(offsets, buf.Len())
		fmt.Fprintf(&buf, "%d 0 obj\n%s\nendobj\n", i+1, obj)
	}
	xref := buf.Len()
	fmt.Fprintf(&buf, "xref\n0 5\n0000000000 65535 f \n")
	for _, offset := range offsets[1:] {
		fmt.Fprintf(&buf, "%010d 00000 n \n", offset)
	}
	fmt.Fprintf(&buf, "trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", xref)
	return buf.Bytes()
}

func TestRealPythonPDFVariantsAndProbe(t *testing.T) {
	r := realRunner(t)
	report, err := r.Probe(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err := report.Validate(); err != nil {
		t.Fatal(err)
	}
	req := requestFor(t)
	req.Timeout = 30 * time.Second
	req.OutputLimit = req.Limits.PdfMaxResultsTotalBytes
	req.Options = json.RawMessage(`{"tool":"pdf-compress","levels":["high","balanced","small"]}`)
	if err := os.WriteFile(req.Source, minimalPDF(), 0600); err != nil {
		t.Fatal(err)
	}
	req.Results = nil
	for i, level := range []string{"high", "balanced", "small"} {
		path := filepath.Join(filepath.Dir(req.Source), level)
		if err := os.WriteFile(path, nil, 0600); err != nil {
			t.Fatal(err)
		}
		req.Results = append(req.Results, ResultTarget{ID: fmt.Sprintf("a7b5ad82-759d-4e3d-ab02-3eae25e2c1f%d", i), Level: level, Path: path})
	}
	var analysis bool
	var results int
	out, err := r.Run(context.Background(), req, func(event Event) error {
		if event.Kind == KindAnalysis {
			analysis = true
		}
		if event.Kind == KindResult {
			results++
		}
		return nil
	})
	if err != nil || out.ErrorCode != "" || !analysis || results != 3 {
		t.Fatalf("out=%+v err=%v analysis=%v results=%d", out, err, analysis, results)
	}
	for _, target := range req.Results {
		data, err := os.ReadFile(target.Path)
		if err != nil || !bytes.HasPrefix(data, []byte("%PDF-")) {
			t.Fatal("invalid PDF result", err)
		}
	}
}
