package endpoints

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"miconverter/server/internal/converter"
)

func rotateReport(t *testing.T, f *apiFixture) {
	t.Helper()
	raw := `{"schemaVersion":3,"protocolVersion":1,"generatedAt":"` + time.Now().UTC().Format(time.RFC3339Nano) + `","inputFormats":["jpeg","png","webp","gif","bmp","ico","avif"],"outputFormats":["jpeg","png","webp","bmp","ico"],"pdf":true,"audio":{"inputFormats":["mp3","wav","flac","ogg"],"outputFormats":["mp3","wav","flac","ogg"]},"markdown":{"available":true},"versions":{"python":"3.13.17","pillow":"13.0.0","pikepdf":"10.17.0","qpdf":"12.4.2","soundfile":"0.14.0","libsndfile":"1.2.2","numpy":"2.5.4"}}`
	var report converter.Report
	if err := json.Unmarshal([]byte(raw), &report); err != nil {
		t.Fatal(err)
	}
	if err := converter.WriteReport(filepath.Join(f.api.cfg.StorageDir, converter.ReportFile), report); err != nil {
		t.Fatal(err)
	}
}

func rotateBody(t *testing.T, options, name string, data []byte) ([]byte, string) {
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

const rotateOptions = `{"tool":"pdf-rotate","angle":90,"pages":"1-2"}`

func TestPdfRotateUploadAndCapabilities(t *testing.T) {
	f := fixture(t)
	rotateReport(t, f)
	b, c := rotateBody(t, rotateOptions, "Mein Bericht.pdf", []byte("%PDF-1.7\n%placeholder"))
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
	if j.Tool != "pdf-rotate" || j.Input.Format != "pdf" || j.Input.Width != nil || len(j.Results) != 1 || j.Results[0].Mime != "application/pdf" || j.Results[0].DownloadName != "Mein Bericht-gedreht.pdf" || j.Results[0].Level != nil {
		t.Fatalf("%+v", j)
	}
	var canonical string
	if err := f.pool.QueryRow(t.Context(), `SELECT options::text FROM jobs WHERE tool = 'pdf-rotate'`).Scan(&canonical); err != nil {
		t.Fatal(err)
	}
	var persisted map[string]any
	json.Unmarshal([]byte(canonical), &persisted)
	if len(persisted) != 3 || persisted["tool"] != "pdf-rotate" || persisted["angle"] != float64(90) || persisted["pages"] != "1-2" {
		t.Fatal(canonical)
	}
	r = f.request("GET", "/capabilities", nil, "")
	var caps struct {
		PdfRotate struct {
			Available                    bool
			MaxFileBytes, MaxOutputBytes int
			Angles                       []int
		}
		Tools []string
	}
	json.Unmarshal(r.Body.Bytes(), &caps)
	if r.Code != 200 || !slices.Contains(caps.Tools, "pdf-rotate") || !caps.PdfRotate.Available || caps.PdfRotate.MaxFileBytes != 100_000_000 || caps.PdfRotate.MaxOutputBytes != 300_000_000 || !slices.Equal(caps.PdfRotate.Angles, []int{90, 180, 270}) {
		t.Fatalf("%d %s", r.Code, r.Body.String())
	}
}

func TestPdfRotateRejectsInvalidRequests(t *testing.T) {
	for _, tc := range []struct {
		name, options, file string
		data                []byte
		status              int
	}{
		{"not a pdf", rotateOptions, "x.pdf", []byte("hello world"), 415},
		{"empty", rotateOptions, "x.pdf", nil, 415},
		{"bad angle", `{"tool":"pdf-rotate","angle":45}`, "x.pdf", []byte("%PDF-1.7"), 422},
		{"bad pages", `{"tool":"pdf-rotate","angle":90,"pages":"3-1"}`, "x.pdf", []byte("%PDF-1.7"), 422},
		{"extra option", `{"tool":"pdf-rotate","angle":90,"levels":["high"]}`, "x.pdf", []byte("%PDF-1.7"), 422},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := fixture(t)
			rotateReport(t, f)
			b, c := rotateBody(t, tc.options, tc.file, tc.data)
			r := f.request("POST", "/jobs", b, c)
			if r.Code != tc.status {
				t.Fatalf("%d %s", r.Code, r.Body.String())
			}
		})
	}
}
