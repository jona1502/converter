package converter

import (
	"encoding/json"
	"runtime"
	"testing"
	"time"

	"miconverter/server/internal/config"
	"miconverter/server/internal/jobs"
)

func TestPdfMergeDetailsStrictAndBounded(t *testing.T) {
	for _, tc := range []struct {
		raw string
		ok  bool
	}{
		{`{"pageCount":1,"sourceCount":2}`, true},
		{`{"pageCount":2000,"sourceCount":20}`, true},
		{`{"pageCount":2001,"sourceCount":2}`, false},
		{`{"pageCount":0,"sourceCount":2}`, false},
		{`{"pageCount":3,"sourceCount":1}`, false},
		{`{"pageCount":3,"sourceCount":21}`, false},
		{`{"pageCount":3}`, false},
		{`{"pageCount":3,"sourceCount":2,"path":"/etc/passwd"}`, false},
		{`{"pageCount":3.5,"sourceCount":2}`, false},
		{`{"pageCount":null,"sourceCount":2}`, false},
		{`{"pageCount":3,"sourceCount":2,"sourceCount":2}`, false},
	} {
		_, err := ValidatePdfMergeDetails([]byte(tc.raw))
		if (err == nil) != tc.ok {
			t.Errorf("%s: %v", tc.raw, err)
		}
	}
}

func TestPdfMergeRequestContract(t *testing.T) {
	cfg, err := config.Load(func(k string) (string, bool) {
		if k == "CONVERTER_ENVIRONMENT" {
			return "test", true
		}
		return "", false
	})
	if err != nil {
		t.Fatal(err)
	}
	task := jobs.Task{Tool: "pdf-merge", InputPath: "/data/input", Options: json.RawMessage(`{"tool":"pdf-merge"}`),
		Results: []jobs.TaskResult{{ID: [16]byte{1}, Path: "/data/result"}}}
	req, err := NewProcessor(nil, cfg).request(task)
	if err != nil {
		t.Fatal(err)
	}
	if !req.isPdfMerge() || req.isPDF() || req.isMarkdown() || req.isAudio() {
		t.Fatal("Werkzeugerkennung")
	}
	if req.Timeout != cfg.PdfTimeout || req.OutputLimit != cfg.PdfMaxInputBytes || len(req.Results) != 1 || req.Results[0].Level != "" {
		t.Fatalf("%+v", req)
	}
	if runtime.GOOS == "windows" {
		t.Skip("encode verlangt POSIX-Pfade")
	}
	raw, err := req.encode()
	if err != nil {
		t.Fatal(err)
	}
	var wire struct {
		Timeout, OutputLimit int64
		Results              []struct{ Level *string }
	}
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatal(err)
	}
	if req.Timeout != cfg.PdfTimeout || wire.Timeout != int64(cfg.PdfTimeout/time.Second) ||
		wire.OutputLimit != cfg.PdfMaxInputBytes || len(wire.Results) != 1 || wire.Results[0].Level != nil {
		t.Fatalf("%s", raw)
	}
}

func TestPdfMergeRequestRejectsLevelsAndSeveralResults(t *testing.T) {
	req := audioRequest(t)
	req.Options = json.RawMessage(`{"tool":"pdf-merge"}`)
	req.Results[0].Level = "high"
	if _, err := req.encode(); err == nil {
		t.Fatal("Stufe bei pdf-merge akzeptiert")
	}
}
