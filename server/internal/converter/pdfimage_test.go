package converter

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"miconverter/server/internal/config"
	"miconverter/server/internal/jobs"
)

const pdfImageOptions = `{"dpi":150,"format":"png","pages":"all","quality":0.85,"tool":"pdf-to-image"}`

func TestValidatePdfImageDetails(t *testing.T) {
	limits := DefaultLimits()
	ok := `{"pageCount":3,"sourcePageCount":10,"archive":true}`
	got, err := ValidatePdfImageDetails([]byte(ok), limits)
	if err != nil || string(got) != ok {
		t.Fatalf("%s %v", got, err)
	}
	for name, raw := range map[string]string{
		"null":                `{"pageCount":null,"sourcePageCount":1,"archive":false}`,
		"keine Seite":         `{"pageCount":0,"sourcePageCount":1,"archive":false}`,
		"über Seitengrenze":   `{"pageCount":101,"sourcePageCount":500,"archive":true}`,
		"mehr als Dokument":   `{"pageCount":3,"sourcePageCount":2,"archive":true}`,
		"gebrochen":           `{"pageCount":1.5,"sourcePageCount":2,"archive":true}`,
		"Archiv als Text":     `{"pageCount":1,"sourcePageCount":1,"archive":"true"}`,
		"Archiv fehlt":        `{"pageCount":1,"sourcePageCount":1}`,
		"Zusatzfeld":          `{"pageCount":1,"sourcePageCount":1,"archive":false,"path":"/etc/passwd"}`,
		"doppelter Schlüssel": `{"pageCount":1,"pageCount":2,"sourcePageCount":2,"archive":false}`,
		"Markdowndetails":     `{"pageCount":1}`,
	} {
		if _, err := ValidatePdfImageDetails([]byte(raw), limits); err == nil {
			t.Errorf("%s akzeptiert", name)
		}
	}
	limits.PdfRenderMaxPages = 5
	if _, err := ValidatePdfImageDetails([]byte(`{"pageCount":6,"sourcePageCount":6,"archive":true}`), limits); err == nil {
		t.Error("konfigurierte Seitengrenze wird nicht beachtet")
	}
}

func pdfImageConfig(t *testing.T, extra map[string]string) *config.Config {
	t.Helper()
	cfg, err := config.Load(func(k string) (string, bool) {
		if k == "CONVERTER_ENVIRONMENT" {
			return "test", true
		}
		v, ok := extra[k]
		return v, ok
	})
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

func TestAdapterBuildsPdfImageRequest(t *testing.T) {
	cfg := pdfImageConfig(t, map[string]string{"CONVERTER_PDF_RENDER_MAX_PAGES": "40", "CONVERTER_PDF_TIMEOUT_SECONDS": "250"})
	task := jobs.Task{Tool: "pdf-to-image", InputPath: "/data/input", Options: json.RawMessage(pdfImageOptions),
		OutputBudget: 123_456_789, Results: []jobs.TaskResult{{ID: [16]byte{1}, Path: "/data/result"}}}
	req, err := NewProcessor(nil, cfg).request(task)
	if err != nil {
		t.Fatal(err)
	}
	if !req.isPDFImage() || req.isPDF() || req.isAudio() || req.isMarkdown() {
		t.Fatalf("Werkzeugerkennung: %+v", req)
	}
	// Arbeitsreserve des Versuchs begrenzt das Archiv, nicht das globale Budget.
	if req.Timeout != 250*time.Second || req.OutputLimit != 123_456_789 || req.Limits.PdfMaxResultsTotalBytes != 123_456_789 {
		t.Fatalf("Grenzen: timeout=%v output=%d total=%d", req.Timeout, req.OutputLimit, req.Limits.PdfMaxResultsTotalBytes)
	}
	raw, err := req.encode()
	if err != nil {
		t.Fatal(err)
	}
	var wire struct{ Limits map[string]int64 }
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatal(err)
	}
	if wire.Limits["pdfRenderMaxPages"] != 40 || wire.Limits["pdfImageMaxPixels"] != 40_000_000 {
		t.Fatalf("%s", raw)
	}
	task.OutputBudget = 0
	req, err = NewProcessor(nil, cfg).request(task)
	if err != nil || req.OutputLimit != 300_000_000 {
		t.Fatalf("ohne Arbeitsreserve: %+v %v", req, err)
	}
}

func TestRequestRejectsZeroPdfRenderPages(t *testing.T) {
	req := audioRequest(t)
	req.Options = json.RawMessage(pdfImageOptions)
	req.Limits.PdfRenderMaxPages = 0
	if _, err := req.encode(); err == nil {
		t.Fatal("Seitengrenze 0 akzeptiert")
	}
}

// TestPdfImageHelper läuft als Kindprozess und spielt den Konverter nach.
func TestPdfImageHelper(t *testing.T) {
	mode := os.Getenv("CONVERTER_PDFIMAGE_HELPER")
	if mode == "" {
		return
	}
	data, _ := io.ReadAll(os.Stdin)
	var req wireRequest
	_ = json.Unmarshal(data, &req)
	id, path := req.Results[0].ID, req.Results[0].Path
	size := 20
	if mode == "large" {
		size = 4096
	}
	_ = os.WriteFile(path, make([]byte, size), 0o600)
	fmt.Println(`{"kind":"progress","phase":"encode"}`)
	switch mode {
	case "progress", "bad-progress":
		fmt.Println(`{"kind":"progress","phase":"encode","progress":{"step":"encode","current":0,"total":4}}`)
		if mode == "bad-progress" {
			fmt.Println(`{"kind":"progress","phase":"encode","progress":{"step":"encode","current":5,"total":4}}`)
			os.Exit(0)
		}
		fmt.Println(`{"kind":"progress","phase":"encode","progress":{"step":"encode","current":2,"total":4}}`)
	}
	details := `{"pageCount":4,"sourcePageCount":9,"archive":true}`
	if mode == "bad-details" {
		details = `{"format":"png","width":1,"height":1,"sourceWidth":1,"sourceHeight":1,"upscaled":false,"transparencyFlattened":false,"qualityApplied":false}`
	}
	fmt.Printf("{\"kind\":\"result\",\"id\":%q,\"details\":%s}\n", id, details)
	os.Exit(0)
}

func pdfImageRunner(mode string) *Runner {
	r := NewRunner()
	r.python = os.Args[0]
	r.args = []string{"-test.run=^TestPdfImageHelper$", "--"}
	r.env = []string{"CONVERTER_PDFIMAGE_HELPER=" + mode, "PATH=" + os.Getenv("PATH"), "GORACE=atexit_sleep_ms=0"}
	r.waitDelay = 100 * time.Millisecond
	return r
}

func pdfImageRequest(t *testing.T) Request {
	req := audioRequest(t)
	req.Options = json.RawMessage(pdfImageOptions)
	req.Timeout = 300 * time.Second
	return req
}

func TestRunnerAcceptsPdfImageProgressAndDetails(t *testing.T) {
	var events []Event
	out, err := pdfImageRunner("progress").Run(context.Background(), pdfImageRequest(t), func(e Event) error { events = append(events, e); return nil })
	if err != nil || out.ErrorCode != "" || len(events) != 4 {
		t.Fatalf("out=%+v err=%v events=%+v", out, err, events)
	}
	if p := events[2].Progress; events[2].Kind != KindProgress || p == nil || *p != (Progress{Step: "encode", Current: 2, Total: 4}) {
		t.Fatalf("Seitenfortschritt: %+v", events[2])
	}
	if events[3].Kind != KindResult || string(events[3].Details) != `{"pageCount":4,"sourcePageCount":9,"archive":true}` {
		t.Fatalf("Ergebnis: %+v", events[3])
	}
}

func TestRunnerRejectsInvalidPdfImageEvents(t *testing.T) {
	for _, mode := range []string{"bad-progress", "bad-details"} {
		out, err := pdfImageRunner(mode).Run(context.Background(), pdfImageRequest(t), func(Event) error { return nil })
		if err != nil || out.ErrorCode != CodeWorkerFailed {
			t.Errorf("%s: out=%+v err=%v", mode, out, err)
		}
	}
}

func TestRunnerBoundsPdfImageOutputByBudget(t *testing.T) {
	req := pdfImageRequest(t)
	req.Limits.PdfMaxResultsTotalBytes = 1024
	var events []Event
	out, err := pdfImageRunner("large").Run(context.Background(), req, func(e Event) error { events = append(events, e); return nil })
	if err != nil || len(events) != 2 || events[1].Kind != KindError || events[1].Code != "result-too-large" {
		t.Fatalf("out=%+v err=%v events=%+v", out, err, events)
	}
}

func TestProbeReportsPdfImageAvailability(t *testing.T) {
	now := time.Now().UTC()
	with := strings.Replace(probeOK, `"markdown":{"available":true},`, `"markdown":{"available":true},"pdfImage":{"available":true},`, 1)
	rep, err := parseProbe([]byte(with), now)
	if err != nil || !rep.PdfImage.Available {
		t.Fatalf("pdfImage verfügbar: %+v %v", rep, err)
	}
	// Ein älterer Bericht ohne Abschnitt bleibt gültig, das Werkzeug aber unverfügbar.
	rep, err = parseProbe([]byte(probeOK), now)
	if err != nil || rep.PdfImage.Available {
		t.Fatalf("ohne Abschnitt: %+v %v", rep, err)
	}
	for _, bad := range []string{`"pdfImage":{"available":1}`, `"pdfImage":{}`, `"pdfImage":{"available":true,"x":1}`, `"pdfImage":true`} {
		raw := strings.Replace(probeOK, `"markdown":{"available":true},`, `"markdown":{"available":true},`+bad+",", 1)
		if _, err := parseProbe([]byte(raw), now); err == nil {
			t.Errorf("%s akzeptiert", bad)
		}
	}
	path := t.TempDir() + "/" + ReportFile
	rep, _ = parseProbe([]byte(with), now)
	if err := WriteReport(path, rep); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadReport(path, now, time.Minute)
	if err != nil || !loaded.PdfImage.Available {
		t.Fatalf("Rundreise des Berichts: %+v %v", loaded, err)
	}
}
