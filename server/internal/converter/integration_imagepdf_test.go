package converter

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"testing"
	"time"

	"miconverter/server/internal/jobs"
)

func imagePdfBundleFile(t *testing.T, path string) {
	t.Helper()
	solid := func(c color.NRGBA) *image.NRGBA {
		img := image.NewNRGBA(image.Rect(0, 0, 40, 60))
		for y := range 60 {
			for x := range 40 {
				img.SetNRGBA(x, y, c)
			}
		}
		return img
	}
	var pngData, jpegData bytes.Buffer
	if err := png.Encode(&pngData, solid(color.NRGBA{R: 255, A: 255})); err != nil {
		t.Fatal(err)
	}
	if err := jpeg.Encode(&jpegData, solid(color.NRGBA{B: 255, A: 255}), nil); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for _, e := range []struct {
		name string
		data []byte
	}{{"001.png", pngData.Bytes()}, {"002.jpg", jpegData.Bytes()}} {
		part, err := w.CreateHeader(&zip.FileHeader{Name: e.name, Method: zip.Store})
		if err != nil {
			t.Fatal(err)
		}
		part.Write(e.data)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestRealPythonImagePdfPipeline(t *testing.T) {
	r := realRunner(t)
	report, err := r.Probe(context.Background())
	if err != nil || !report.ImagePdfAvailable() {
		t.Fatalf("probe=%+v err=%v", report, err)
	}
	for _, tc := range []struct {
		name, code  string
		outputLimit int64
	}{
		{"valid", "", 104857600},
		{"output-bound", "result-too-large", 100},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := requestFor(t)
			req.Options = json.RawMessage(`{"tool":"image-pdf","pageSize":"a4","orientation":"auto","margin":"small"}`)
			req.Timeout = 60 * time.Second
			req.Limits.ImageMaxOutputBytes = tc.outputLimit
			imagePdfBundleFile(t, req.Source)
			var code string
			var details json.RawMessage
			out, err := r.Run(context.Background(), req, func(e Event) error {
				if e.Kind == KindResult {
					details = e.Details
				}
				if e.Kind == KindError {
					code = e.Code
				}
				return nil
			})
			if err != nil || out.ErrorCode != "" || code != tc.code {
				t.Fatalf("out=%+v code=%s err=%v", out, code, err)
			}
			data, err := os.ReadFile(req.Results[0].Path)
			if err != nil {
				t.Fatal(err)
			}
			if tc.code == "" {
				if !jobs.IsPDF(data) || string(details) != `{"pageCount":2}` {
					t.Fatalf("details=%s PDF=%v", details, jobs.IsPDF(data))
				}
			} else if len(data) != 0 {
				t.Fatalf("failed output has %d bytes", len(data))
			}
		})
	}
}

// Ein Bild an der 40-MP-Grenze muss im 1-GiB-Adressraum der Sandbox gelingen
// (JPEG-Durchreichung und Flate-Pfad), eines darüber wird abgewiesen.
func TestRealPythonImagePdfLargeImages(t *testing.T) {
	r := realRunner(t)
	for _, tc := range []struct {
		name, code string
		side       int
	}{
		{"at-limit", "", 6324},
		{"over-limit", "dimensions-too-large", 6400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Worst case: RGBA mit Transparenz (Alpha-Flatten braucht die meisten Kopien).
			img := image.NewNRGBA(image.Rect(0, 0, tc.side, tc.side))
			for y := range tc.side {
				for x := range tc.side {
					i := y*img.Stride + x*4
					img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = byte(x^y), byte(x), byte(y), 200
				}
			}
			var pngData, jpegData bytes.Buffer
			if err := png.Encode(&pngData, img); err != nil {
				t.Fatal(err)
			}
			if err := jpeg.Encode(&jpegData, img, nil); err != nil {
				t.Fatal(err)
			}
			var buf bytes.Buffer
			w := zip.NewWriter(&buf)
			for i, data := range [][]byte{pngData.Bytes(), jpegData.Bytes()} {
				part, err := w.CreateHeader(&zip.FileHeader{Name: []string{"001.png", "002.jpg"}[i], Method: zip.Store})
				if err != nil {
					t.Fatal(err)
				}
				part.Write(data)
			}
			if err := w.Close(); err != nil {
				t.Fatal(err)
			}
			req := requestFor(t)
			req.Options = json.RawMessage(`{"tool":"image-pdf"}`)
			req.Timeout = 120 * time.Second
			if err := os.WriteFile(req.Source, buf.Bytes(), 0600); err != nil {
				t.Fatal(err)
			}
			var code string
			out, err := r.Run(context.Background(), req, func(e Event) error {
				if e.Kind == KindError {
					code = e.Code
				}
				return nil
			})
			if err != nil || out.ErrorCode != "" || code != tc.code {
				t.Fatalf("out=%+v code=%s err=%v", out, code, err)
			}
		})
	}
}
