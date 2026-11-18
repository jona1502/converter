package converter

import (
	"encoding/json"
	"testing"
	"time"

	"miconverter/server/internal/config"
	"miconverter/server/internal/jobs"
)

func TestImagePdfRequestContract(t *testing.T) {
	cfg, err := config.Load(func(k string) (string, bool) {
		if k == "CONVERTER_ENVIRONMENT" {
			return "test", true
		}
		return "", false
	})
	if err != nil {
		t.Fatal(err)
	}
	task := jobs.Task{Tool: "image-pdf", InputPath: "/data/input", OutputBudget: 104857600,
		Options: json.RawMessage(`{"tool":"image-pdf","pageSize":"a4","orientation":"auto","margin":"small"}`),
		Results: []jobs.TaskResult{{ID: [16]byte{1}, Path: "/data/result"}}}
	req, err := NewProcessor(nil, cfg).request(task)
	if err != nil {
		t.Fatal(err)
	}
	// Nur Felder prüfen, nicht encode(): das verlangt POSIX-Pfade (Container).
	raw, err := json.Marshal(req.Limits)
	if err != nil {
		t.Fatal(err)
	}
	var limits map[string]int64
	if err := json.Unmarshal(raw, &limits); err != nil {
		t.Fatal(err)
	}
	if !req.isImagePdf() || req.isPDF() || req.Timeout != 300*time.Second ||
		req.OutputLimit != 104857600 || limits["imagePdfMaxImages"] != 30 ||
		limits["imagePdfMaxInputBytes"] != 104857600 {
		t.Fatalf("%+v %s", req, raw)
	}
}

func TestImagePdfRequestRejectsZeroLimits(t *testing.T) {
	for _, field := range []string{"images", "input"} {
		req := audioRequest(t)
		req.Options = json.RawMessage(`{"tool":"image-pdf"}`)
		if field == "images" {
			req.Limits.ImagePdfMaxImages = 0
		} else {
			req.Limits.ImagePdfMaxInputBytes = 0
		}
		if _, err := req.encode(); err == nil {
			t.Errorf("accepted zero %s limit", field)
		}
	}
}

func TestImagePdfDetailsStrictAndBounded(t *testing.T) {
	for _, tc := range []struct {
		raw string
		ok  bool
	}{
		{`{"pageCount":1}`, true}, {`{"pageCount":30}`, true}, {`{"pageCount":31}`, false},
		{`{"pageCount":0}`, false}, {`{"pageCount":1.5}`, false}, {`{"pageCount":null}`, false},
		{`{"pageCount":1,"url":"file:///secret"}`, false}, {`{"pageCount":1,"pageCount":2}`, false},
	} {
		_, err := ValidateImagePdfDetails([]byte(tc.raw), DefaultLimits())
		if (err == nil) != tc.ok {
			t.Errorf("%s %v", tc.raw, err)
		}
	}
}
