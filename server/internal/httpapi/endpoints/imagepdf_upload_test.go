package endpoints

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"miconverter/server/internal/converter"
)

var tinyPNG = append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{7}, 64)...)

// imagePdfBundle baut ein gültiges Bündel mit n Bildern (nur Kopf, Erkennung per Signatur).
func imagePdfBundle(t *testing.T, n int, size int) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for i := 1; i <= n; i++ {
		part, err := w.CreateHeader(&zip.FileHeader{Name: fmt.Sprintf("%03d.png", i), Method: zip.Store})
		if err != nil {
			t.Fatal(err)
		}
		data := append(append([]byte{}, tinyPNG...), bytes.Repeat([]byte{1}, size)...)
		part.Write(data)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func imagePdfBody(t *testing.T, options, name string, data []byte) ([]byte, string) {
	t.Helper()
	var b bytes.Buffer
	w := multipart.NewWriter(&b)
	p, err := w.CreateFormField("options")
	if err != nil {
		t.Fatal(err)
	}
	io.WriteString(p, options)
	p, err = w.CreateFormFile("file", name)
	if err != nil {
		t.Fatal(err)
	}
	p.Write(data)
	w.Close()
	return b.Bytes(), w.FormDataContentType()
}

func TestImagePdfUploadCreatesJob(t *testing.T) {
	f := fixture(t)
	markdownReport(t, f, true)
	b, c := imagePdfBody(t, `{"tool":"image-pdf","pageSize":"letter"}`, "Urlaub.zip", imagePdfBundle(t, 3, 10))
	r := f.request("POST", "/jobs", b, c)
	if r.Code != 202 {
		t.Fatalf("%d %s", r.Code, r.Body.String())
	}
	var j struct {
		Tool  string
		Input struct {
			Format string
			Width  *int
		}
		Results []struct {
			Mime, DownloadName string
			Level              *string
		}
	}
	if err := json.Unmarshal(r.Body.Bytes(), &j); err != nil {
		t.Fatal(err)
	}
	if j.Tool != "image-pdf" || j.Input.Format != "zip" || j.Input.Width != nil || len(j.Results) != 1 ||
		j.Results[0].Mime != "application/pdf" || j.Results[0].DownloadName != "Urlaub.pdf" || j.Results[0].Level != nil {
		t.Fatalf("%+v", j)
	}
	var canonical string
	if err := f.pool.QueryRow(t.Context(), `SELECT options::text FROM jobs WHERE tool = 'image-pdf'`).Scan(&canonical); err != nil {
		t.Fatal(err)
	}
	var persisted map[string]any
	json.Unmarshal([]byte(canonical), &persisted)
	if len(persisted) != 4 || persisted["pageSize"] != "letter" || persisted["orientation"] != "auto" || persisted["margin"] != "small" {
		t.Fatal(canonical)
	}
}

func TestImagePdfRejectsBadBundles(t *testing.T) {
	var many bytes.Buffer
	{
		w := zip.NewWriter(&many)
		for i := 1; i <= 31; i++ {
			p, _ := w.CreateHeader(&zip.FileHeader{Name: fmt.Sprintf("%03d.png", i), Method: zip.Store})
			p.Write(tinyPNG)
		}
		w.Close()
	}
	for _, tc := range []struct {
		name, file string
		data       []byte
		status     int
	}{
		{"kein zip", "x.zip", []byte("kein zip"), 415},
		{"falsche Endung", "x.png", imagePdfBundle(t, 1, 0), 415},
		{"leer", "x.zip", nil, 415},
		{"zu viele Bilder", "x.zip", many.Bytes(), 413},
		{"einzelnes Bild", "x.zip", tinyPNG, 415},
		{"gueltig", "x.zip", imagePdfBundle(t, 30, 0), 202},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := fixture(t)
			markdownReport(t, f, true)
			b, c := imagePdfBody(t, `{"tool":"image-pdf"}`, tc.file, tc.data)
			r := f.request("POST", "/jobs", b, c)
			if r.Code != tc.status {
				t.Fatalf("%d %s", r.Code, r.Body.String())
			}
		})
	}
}

func TestImagePdfRejectsInvalidOptionsBeforeStoring(t *testing.T) {
	f := fixture(t)
	markdownReport(t, f, true)
	b, c := imagePdfBody(t, `{"tool":"image-pdf","pageSize":"fit","orientation":"portrait"}`, "x.zip", imagePdfBundle(t, 1, 0))
	r := f.request("POST", "/jobs", b, c)
	if r.Code != 422 || !strings.Contains(r.Body.String(), "invalid-options") {
		t.Fatalf("%d %s", r.Code, r.Body.String())
	}
}

func TestImagePdfCapabilityGatesCreationAndIsAdvertised(t *testing.T) {
	f := fixture(t)
	markdownReport(t, f, true)
	r := f.request("GET", "/capabilities", nil, "")
	var caps struct {
		Tools    []string
		ImagePdf struct {
			Available                                               bool
			MaxImages, MaxImageBytes, MaxTotalBytes, MaxOutputBytes int
		}
	}
	if err := json.Unmarshal(r.Body.Bytes(), &caps); err != nil {
		t.Fatal(err)
	}
	if r.Code != 200 || !slices.Contains(caps.Tools, "image-pdf") || !caps.ImagePdf.Available ||
		caps.ImagePdf.MaxImages != 30 || caps.ImagePdf.MaxImageBytes != 52428800 ||
		caps.ImagePdf.MaxTotalBytes != 104857600 || caps.ImagePdf.MaxOutputBytes != 104857600 {
		t.Fatalf("%d %s", r.Code, r.Body.String())
	}
	// Ohne gültigen Konverterbericht (Probe nicht bestätigt) wird nichts angenommen.
	if err := os.Remove(filepath.Join(f.api.cfg.StorageDir, converter.ReportFile)); err != nil {
		t.Fatal(err)
	}
	b, c := imagePdfBody(t, `{"tool":"image-pdf"}`, "x.zip", imagePdfBundle(t, 1, 0))
	r = f.request("POST", "/jobs", b, c)
	if r.Code != 503 || !strings.Contains(r.Body.String(), "service-unavailable") {
		t.Fatalf("%d %s", r.Code, r.Body.String())
	}
}
