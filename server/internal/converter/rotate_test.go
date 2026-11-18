package converter

import (
	"encoding/json"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"

	"miconverter/server/internal/config"
	"miconverter/server/internal/jobs"
)

func TestPdfRotateDetailsStrictAndBounded(t *testing.T) {
	for _, tc := range []struct {
		raw string
		ok  bool
	}{
		{`{"pageCount":1,"rotatedPages":1}`, true}, {`{"pageCount":500,"rotatedPages":3}`, true},
		{`{"pageCount":3,"rotatedPages":4}`, false}, {`{"pageCount":3,"rotatedPages":0}`, false},
		{`{"pageCount":0,"rotatedPages":0}`, false}, {`{"pageCount":1.5,"rotatedPages":1}`, false},
		{`{"pageCount":"3","rotatedPages":1}`, false}, {`{"pageCount":3}`, false},
		{`{"pageCount":3,"rotatedPages":1,"path":"/etc/passwd"}`, false},
		{`{"pageCount":3,"pageCount":3,"rotatedPages":1}`, false},
		{`{"pageCount":99999999999,"rotatedPages":1}`, false}, {`[]`, false},
	} {
		got, err := ValidatePdfRotateDetails([]byte(tc.raw))
		if (err == nil) != tc.ok {
			t.Errorf("%s: %v", tc.raw, err)
		}
		if err == nil && !strings.Contains(string(got), "rotatedPages") {
			t.Errorf("%s: %s", tc.raw, got)
		}
	}
}

func TestPdfRotateRequestContract(t *testing.T) {
	cfg, err := config.Load(func(k string) (string, bool) { return "test", k == "CONVERTER_ENVIRONMENT" })
	if err != nil {
		t.Fatal(err)
	}
	opts := json.RawMessage(`{"angle":90,"pages":"all","tool":"pdf-rotate"}`)
	req, err := NewProcessor(nil, cfg).request(jobs.Task{Tool: "pdf-rotate", InputPath: "/data/input", Options: opts, Results: []jobs.TaskResult{{ID: [16]byte{1}, Path: "/data/result"}}})
	if err != nil {
		t.Fatal(err)
	}
	if !req.isRotate() || req.isPDF() || req.Timeout != cfg.PdfTimeout || req.OutputLimit != cfg.PdfMaxResultsTotalBytes || req.Timeout < time.Second {
		t.Fatalf("%+v", req)
	}
	if runtime.GOOS == "windows" {
		t.Skip("Protokollpfade sind POSIX-Pfade (checkPath)")
	}
	raw, err := req.encode()
	if err != nil {
		t.Fatal(err)
	}
	var wire struct {
		Options map[string]any
		Results []map[string]any
	}
	if err := json.Unmarshal(raw, &wire); err != nil || wire.Options["tool"] != "pdf-rotate" || len(wire.Results) != 1 || wire.Results[0]["level"] != nil {
		t.Fatalf("%v %s", err, raw)
	}
}

func TestPdfRotateRejectsLevelledResults(t *testing.T) {
	req := audioRequest(t)
	req.Options = json.RawMessage(`{"angle":90,"pages":"all","tool":"pdf-rotate"}`)
	req.Results[0].Level = "high"
	if _, err := req.encode(); err == nil {
		t.Fatal("pdf-rotate with a compression level accepted")
	}
}

func TestPdfRotateSessionAcceptsOnlyValidResult(t *testing.T) {
	for _, tc := range []struct {
		name, details string
		ok            bool
	}{
		{"valid", `{"pageCount":4,"rotatedPages":2}`, true},
		{"page count missing", `{"rotatedPages":2}`, false},
		{"markdown details", `{"pageCount":4}`, false},
		{"extra field", `{"pageCount":4,"rotatedPages":2,"x":1}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := audioRequest(t)
			req.Options = json.RawMessage(`{"angle":90,"pages":"all","tool":"pdf-rotate"}`)
			if err := os.WriteFile(req.Results[0].Path, []byte("%PDF-1.7"), 0o600); err != nil {
				t.Fatal(err)
			}
			var got []Event
			s := &session{req: req, rotate: req.isRotate(), onEvent: func(e Event) error { got = append(got, e); return nil }}
			line := `{"kind":"result","id":"` + req.Results[0].ID + `","details":` + tc.details + `}`
			err := s.handle([]byte(line))
			if (err == nil) != tc.ok {
				t.Fatalf("%v", err)
			}
			if tc.ok && (len(got) != 1 || got[0].Kind != KindResult || string(got[0].Details) != tc.details) {
				t.Fatalf("%+v", got)
			}
		})
	}
}
