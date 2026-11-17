package endpoints

import (
	"bytes"
	"encoding/json"
	"io"
	"miconverter/server/internal/converter"
	"mime/multipart"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func markdownReport(t *testing.T, f *apiFixture, available bool) {
	t.Helper()
	raw := `{"schemaVersion":3,"protocolVersion":1,"generatedAt":"` + time.Now().UTC().Format(time.RFC3339Nano) + `","inputFormats":["jpeg","png","webp","gif","bmp","ico","avif"],"outputFormats":["jpeg","png","webp","bmp","ico"],"pdf":true,"audio":{"inputFormats":["mp3","wav","flac","ogg"],"outputFormats":["mp3","wav","flac","ogg"]},"markdown":{"available":` + map[bool]string{true: "true", false: "false"}[available] + `},"versions":{"python":"3.13.17","pillow":"13.0.0","pikepdf":"10.17.0","qpdf":"12.4.2","soundfile":"0.14.0","libsndfile":"1.2.2","numpy":"2.5.4"}}`
	var report converter.Report
	if err := json.Unmarshal([]byte(raw), &report); err != nil {
		t.Fatal(err)
	}
	if err := converter.WriteReport(filepath.Join(f.api.cfg.StorageDir, converter.ReportFile), report); err != nil {
		t.Fatal(err)
	}
}
func markdownBody(t *testing.T, name string, data []byte) ([]byte, string) {
	t.Helper()
	var b bytes.Buffer
	w := multipart.NewWriter(&b)
	p, err := w.CreateFormField("options")
	if err != nil {
		t.Fatal(err)
	}
	io.WriteString(p, `{"tool":"markdown-pdf"}`)
	p, err = w.CreateFormFile("file", name)
	if err != nil {
		t.Fatal(err)
	}
	p.Write(data)
	w.Close()
	return b.Bytes(), w.FormDataContentType()
}
func TestMarkdownOptionsCanonicalAndStrict(t *testing.T) {
	o, err := parseOptions([]byte(`{"tool":"markdown-pdf"}`))
	if err != nil || o.tool != "markdown-pdf" || string(o.canonical) != `{"tool":"markdown-pdf"}` {
		t.Fatalf("%+v %v", o, err)
	}
	for _, raw := range []string{`{"tool":"markdown-pdf","format":"pdf"}`, `{"tool":"markdown-pdf","levels":null}`} {
		if _, err := parseOptions([]byte(raw)); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
}
func TestMarkdownUploadAndCapabilities(t *testing.T) {
	for _, name := range []string{"Mein Text.md", "Mein Text.MARKDOWN"} {
		t.Run(name, func(t *testing.T) {
			f := fixture(t)
			markdownReport(t, f, true)
			b, c := markdownBody(t, name, []byte("\xef\xbb\xbf# Grüße\n"))
			r := f.request("POST", "/jobs", b, c)
			if r.Code != 202 {
				t.Fatalf("%d %s", r.Code, r.Body.String())
			}
			var j struct {
				Tool    string
				Options map[string]any
				Input   struct {
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
			if j.Tool != "markdown-pdf" || j.Input.Format != "markdown" || j.Input.Width != nil || len(j.Results) != 1 || j.Results[0].Mime != "application/pdf" || j.Results[0].DownloadName != "Mein Text.pdf" || j.Results[0].Level != nil {
				t.Fatalf("%+v", j)
			}
			var canonical string
			if err := f.pool.QueryRow(t.Context(), `SELECT options::text FROM jobs WHERE tool = 'markdown-pdf'`).Scan(&canonical); err != nil {
				t.Fatal(err)
			}
			var persisted map[string]any
			json.Unmarshal([]byte(canonical), &persisted)
			if len(persisted) != 1 || persisted["tool"] != "markdown-pdf" {
				t.Fatal(canonical)
			}
			r = f.request("GET", "/capabilities", nil, "")
			var caps struct {
				Markdown struct {
					Available                              bool
					MaxFileBytes, MaxOutputBytes, MaxPages int
				}
				Tools []string
			}
			json.Unmarshal(r.Body.Bytes(), &caps)
			if r.Code != 200 || !slices.Contains(caps.Tools, "markdown-pdf") || !caps.Markdown.Available || caps.Markdown.MaxFileBytes != 2097152 || caps.Markdown.MaxOutputBytes != 20971520 || caps.Markdown.MaxPages != 300 {
				t.Fatalf("%d %s", r.Code, r.Body.String())
			}
		})
	}
}
func TestMarkdownRejectsInvalidFullSourceAndBounds(t *testing.T) {
	for _, tc := range []struct {
		name   string
		data   []byte
		status int
	}{
		{"empty", nil, 415}, {"whitespace", []byte("\xef\xbb\xbf \t\r\n\u2003"), 415},
		{"late-invalid", append(bytes.Repeat([]byte("a"), 100000), 0xff), 415},
		{"late-control", append(bytes.Repeat([]byte("a"), 100000), 0), 415},
		{"c1", []byte("hello\u0085"), 415},
		{"limit", bytes.Repeat([]byte("a"), 2097152), 202},
		{"over", bytes.Repeat([]byte("a"), 2097153), 413},
		{"split-rune", []byte(strings.Repeat("a", 65535) + "ä"), 202},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := fixture(t)
			markdownReport(t, f, true)
			b, c := markdownBody(t, "test.md", tc.data)
			r := f.request("POST", "/jobs", b, c)
			if r.Code != tc.status {
				t.Fatalf("%d %s", r.Code, r.Body.String())
			}
		})
	}
}
func TestMarkdownCapabilityGatesCreation(t *testing.T) {
	f := fixture(t)
	markdownReport(t, f, false)
	b, c := markdownBody(t, "test.md", []byte("# Test"))
	r := f.request("POST", "/jobs", b, c)
	if r.Code != 503 || !strings.Contains(r.Body.String(), "service-unavailable") {
		t.Fatalf("%d %s", r.Code, r.Body.String())
	}
	r = f.request("GET", "/capabilities", nil, "")
	var caps struct {
		Tools    []string
		Markdown struct{ Available bool }
	}
	if err := json.Unmarshal(r.Body.Bytes(), &caps); err != nil {
		t.Fatal(err)
	}
	if r.Code != 200 || caps.Markdown.Available || slices.Contains(caps.Tools, "markdown-pdf") {
		t.Fatalf("%d %s", r.Code, r.Body.String())
	}
}

func TestMarkdownTruncatedUploadPreservesBodyError(t *testing.T) {
	f := fixture(t)
	markdownReport(t, f, true)
	b, c := markdownBody(t, "test.md", []byte("# Test"))
	r := f.request("POST", "/jobs", b[:len(b)-20], c)
	if r.Code != 400 {
		t.Fatalf("%d %s", r.Code, r.Body.String())
	}
}

func TestMarkdownReplayValidatesAllBytes(t *testing.T) {
	f := fixture(t)
	markdownReport(t, f, true)
	b, c := markdownBody(t, "test.md", []byte("# Test"))
	r := f.request("POST", "/jobs", b, c)
	if r.Code != 202 {
		t.Fatalf("%d %s", r.Code, r.Body.String())
	}
	b, c = markdownBody(t, "test.md", append(bytes.Repeat([]byte("a"), 100000), 0xff))
	r = f.request("POST", "/jobs", b, c)
	if r.Code != 415 {
		t.Fatalf("%d %s", r.Code, r.Body.String())
	}
}
