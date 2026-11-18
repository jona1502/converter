package endpoints

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"miconverter/server/internal/contracttest"
	"miconverter/server/internal/converter"
)

func pdfImageReport(t *testing.T, f *apiFixture, available bool) {
	t.Helper()
	report := converter.Report{SchemaVersion: converter.ReportSchemaVersion, ProtocolVersion: converter.ProtocolVersion,
		GeneratedAt: time.Now().UTC(), InputFormats: converter.RequiredInputFormats, OutputFormats: converter.RequiredOutputFormats,
		PDF: true, Audio: converter.AudioReport{InputFormats: converter.RequiredAudioFormats, OutputFormats: converter.RequiredAudioFormats},
		PdfImage: converter.PdfImageReport{Available: available},
		Versions: converter.Versions{Python: "3.13.17", Pillow: "13.0.0", Pikepdf: "10.17.0", Qpdf: "12.4.2",
			Soundfile: "0.14.0", Libsndfile: "1.2.2", Numpy: "2.5.4"}}
	if err := converter.WriteReport(filepath.Join(f.api.cfg.StorageDir, converter.ReportFile), report); err != nil {
		t.Fatal(err)
	}
}

func bodyNamed(t *testing.T, options, name string, data []byte) ([]byte, string) {
	t.Helper()
	var b bytes.Buffer
	writer := multipart.NewWriter(&b)
	part, err := writer.CreateFormField("options")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.WriteString(part, options)
	if part, err = writer.CreateFormFile("file", name); err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write(data)
	_ = writer.Close()
	return b.Bytes(), writer.FormDataContentType()
}

type pdfImageJob struct {
	Tool  string `json:"tool"`
	Input struct {
		Format string `json:"format"`
		Name   string `json:"name"`
		Width  *int   `json:"width"`
	} `json:"input"`
	Results []struct {
		Mime         string  `json:"mime"`
		DownloadName string  `json:"downloadName"`
		Level        *string `json:"level"`
	} `json:"results"`
}

func TestPdfImageUploadDecidesBetweenImageAndArchive(t *testing.T) {
	cases := []struct {
		options, mime, name string
	}{
		{`{"tool":"pdf-to-image","format":"png"}`, "application/zip", "Mein Bericht-bilder.zip"},
		{`{"tool":"pdf-to-image","format":"jpeg","pages":"all","dpi":72}`, "application/zip", "Mein Bericht-bilder.zip"},
		{`{"tool":"pdf-to-image","format":"jpeg","pages":"1,3"}`, "application/zip", "Mein Bericht-bilder.zip"},
		{`{"tool":"pdf-to-image","format":"jpeg","pages":"3"}`, "image/jpeg", "Mein Bericht-seite-3.jpg"},
		{`{"tool":"pdf-to-image","format":"webp","pages":"2-2","quality":0.5}`, "image/webp", "Mein Bericht-seite-2.webp"},
		{`{"tool":"pdf-to-image","format":"png","pages":"12"}`, "image/png", "Mein Bericht-seite-12.png"},
	}
	for _, c := range cases {
		f := fixture(t)
		pdfImageReport(t, f, true)
		payload, content := bodyNamed(t, c.options, "Mein Bericht.pdf", []byte("%PDF-1.7\n%%EOF\n"))
		response := f.request("POST", "/jobs", payload, content)
		if response.Code != 202 {
			t.Fatalf("%s: %d %s", c.options, response.Code, response.Body.String())
		}
		var job pdfImageJob
		if err := json.Unmarshal(response.Body.Bytes(), &job); err != nil {
			t.Fatal(err)
		}
		if job.Tool != "pdf-to-image" || job.Input.Format != "pdf" || job.Input.Width != nil || job.Input.Name != "Mein Bericht.pdf" ||
			len(job.Results) != 1 || job.Results[0].Mime != c.mime || job.Results[0].DownloadName != c.name || job.Results[0].Level != nil {
			t.Errorf("%s: %+v", c.options, job)
		}
	}
}

func TestPdfImageStoresCanonicalOptions(t *testing.T) {
	f := fixture(t)
	pdfImageReport(t, f, true)
	payload, content := body(t, `{"tool":"pdf-to-image","format":"png","pages":"3,1,2"}`, []byte("%PDF-1.7\n"))
	if response := f.request("POST", "/jobs", payload, content); response.Code != 202 {
		t.Fatalf("%d %s", response.Code, response.Body.String())
	}
	var canonical string
	if err := f.pool.QueryRow(t.Context(), `SELECT options::text FROM jobs WHERE tool = 'pdf-to-image'`).Scan(&canonical); err != nil {
		t.Fatal(err)
	}
	var persisted map[string]any
	if err := json.Unmarshal([]byte(canonical), &persisted); err != nil {
		t.Fatal(err)
	}
	if len(persisted) != 5 || persisted["pages"] != "1-3" || persisted["dpi"] != float64(150) || persisted["quality"] != 0.85 || persisted["format"] != "png" {
		t.Fatal(canonical)
	}
}

func TestPdfImageUploadRejections(t *testing.T) {
	f := fixture(t)
	pdfImageReport(t, f, true)
	f.api.cfg.PdfRenderMaxPages = 3
	cases := []struct {
		name, options string
		data          []byte
		status        int
		code          string
	}{
		{"kein PDF", `{"tool":"pdf-to-image","format":"png"}`, pngBytes(t), 415, "not-pdf"},
		{"Markdown statt PDF", `{"tool":"pdf-to-image","format":"png"}`, []byte("# Titel\n"), 415, "not-pdf"},
		{"zu viele gewählte Seiten", `{"tool":"pdf-to-image","format":"png","pages":"1-4"}`, []byte("%PDF-1.7\n"), 422, "invalid-options"},
		{"Seitenauswahl ungültig", `{"tool":"pdf-to-image","format":"png","pages":"4-1"}`, []byte("%PDF-1.7\n"), 422, "invalid-options"},
		{"dpi zu hoch", `{"tool":"pdf-to-image","format":"png","dpi":600}`, []byte("%PDF-1.7\n"), 422, "invalid-options"},
		{"Format unbekannt", `{"tool":"pdf-to-image","format":"tiff"}`, []byte("%PDF-1.7\n"), 422, "invalid-options"},
	}
	for _, c := range cases {
		payload, content := body(t, c.options, c.data)
		response := f.request("POST", "/jobs", payload, content)
		var problem struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		_ = json.Unmarshal(response.Body.Bytes(), &problem)
		if response.Code != c.status || problem.Error.Code != c.code {
			t.Errorf("%s: %d %s", c.name, response.Code, response.Body.String())
		}
	}
	// Genau so viele Seiten wie erlaubt werden angenommen.
	payload, content := body(t, `{"tool":"pdf-to-image","format":"png","pages":"5-7"}`, []byte("%PDF-1.7\n"))
	if response := f.request("POST", "/jobs", payload, content); response.Code != 202 {
		t.Fatalf("Seitengrenze: %d %s", response.Code, response.Body.String())
	}
	var reserved, count int64
	_ = f.pool.QueryRow(t.Context(), "SELECT reserved_bytes FROM storage_usage WHERE id=1").Scan(&reserved)
	_ = f.pool.QueryRow(t.Context(), "SELECT count(*) FROM upload_reservations").Scan(&count)
	if count != 0 {
		t.Fatalf("Reservierung bleibt: %d Bytes, %d Einträge", reserved, count)
	}
}

func TestPdfImageUploadNeedsAvailableRenderer(t *testing.T) {
	f := fixture(t)
	pdfImageReport(t, f, false)
	payload, content := body(t, `{"tool":"pdf-to-image","format":"png"}`, []byte("%PDF-1.7\n"))
	response := f.request("POST", "/jobs", payload, content)
	if response.Code != 503 || !strings.Contains(response.Body.String(), "service-unavailable") {
		t.Fatalf("%d %s", response.Code, response.Body.String())
	}
}

func TestPdfImageCapabilities(t *testing.T) {
	f := fixture(t)
	pdfImageReport(t, f, true)
	response := f.request("GET", "/capabilities", nil, "")
	var caps struct {
		Tools    []string        `json:"tools"`
		PdfImage json.RawMessage `json:"pdfImage"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &caps); err != nil {
		t.Fatal(err)
	}
	if response.Code != 200 || !slices.Contains(caps.Tools, "pdf-to-image") {
		t.Fatalf("%d %v", response.Code, caps.Tools)
	}
	if err := contracttest.MustLoad(t).ValidateComponent("PdfImageCapabilities", caps.PdfImage); err != nil {
		t.Fatalf("pdfImage: %v (%s)", err, caps.PdfImage)
	}
	want := `{"available":true,"formats":["png","jpeg","webp"],"qualityFormats":["jpeg","webp"],"minDpi":72,"maxDpi":300,` +
		`"defaultDpi":150,"maxFileBytes":100000000,"maxOutputBytes":300000000,"maxPages":100,"maxPixels":40000000}`
	if string(caps.PdfImage) != want {
		t.Fatalf("pdfImage:\n%s\n%s", caps.PdfImage, want)
	}
	pdfImageReport(t, f, false)
	response = f.request("GET", "/capabilities", nil, "")
	caps.Tools = nil
	if err := json.Unmarshal(response.Body.Bytes(), &caps); err != nil || slices.Contains(caps.Tools, "pdf-to-image") ||
		!strings.Contains(string(caps.PdfImage), `"available":false`) {
		t.Fatalf("nicht verfügbar: %v %s %v", caps.Tools, caps.PdfImage, err)
	}
}
