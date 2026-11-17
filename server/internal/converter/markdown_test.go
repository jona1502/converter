package converter

import (
	"encoding/json"
	"testing"
	"time"

	"miconverter/server/internal/config"
	"miconverter/server/internal/jobs"
)

func TestMarkdownRequestContract(t *testing.T) {
	cfg, err := config.Load(func(k string) (string, bool) {
		if k == "CONVERTER_ENVIRONMENT" {
			return "test", true
		}
		return "", false
	})
	if err != nil {
		t.Fatal(err)
	}
	req, err := NewProcessor(nil, cfg).request(jobs.Task{Tool: "markdown-pdf", InputPath: "/data/input", Options: json.RawMessage(`{"tool":"markdown-pdf"}`), OutputBudget: 20971520, Results: []jobs.TaskResult{{ID: [16]byte{1}, Path: "/data/result"}}})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := req.encode()
	if err != nil {
		t.Fatal(err)
	}
	var wire struct {
		Limits               map[string]int64
		Timeout, OutputLimit int64
	}
	json.Unmarshal(raw, &wire)
	if req.Timeout != 120*time.Second || wire.Timeout != 120 || wire.OutputLimit != 20971520 || wire.Limits["markdownMaxInputBytes"] != 2097152 || wire.Limits["markdownMaxOutputBytes"] != 20971520 || wire.Limits["markdownMaxPages"] != 300 {
		t.Fatalf("%s", raw)
	}
}

func TestMarkdownProbeContract(t *testing.T) {
	raw := []byte(probeOK)
	r, err := parseProbe(raw, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(r)
	var v map[string]any
	json.Unmarshal(data, &v)
	if v["schemaVersion"] != float64(3) || v["markdown"].(map[string]any)["available"] != true {
		t.Fatalf("%s", data)
	}
}

func TestMarkdownDetailsStrictAndBounded(t *testing.T) {
	for _, tc := range []struct {
		raw string
		ok  bool
	}{
		{`{"pageCount":1}`, true}, {`{"pageCount":300}`, true}, {`{"pageCount":301}`, false},
		{`{"pageCount":0}`, false}, {`{"pageCount":1.5}`, false}, {`{"pageCount":null}`, false},
		{`{"pageCount":true}`, false}, {`{"pageCount":1,"url":"file:///secret"}`, false},
		{`{"pageCount":1,"pageCount":2}`, false},
	} {
		_, err := ValidateMarkdownDetails([]byte(tc.raw), DefaultLimits())
		if (err == nil) != tc.ok {
			t.Errorf("%s %v", tc.raw, err)
		}
	}
}

func TestMarkdownRequestRejectsZeroLimits(t *testing.T) {
	for _, field := range []string{"input", "output", "pages"} {
		req := audioRequest(t)
		req.Options = json.RawMessage(`{"tool":"markdown-pdf"}`)
		switch field {
		case "input":
			req.Limits.MarkdownMaxInputBytes = 0
		case "output":
			req.Limits.MarkdownMaxOutputBytes = 0
		case "pages":
			req.Limits.MarkdownMaxPages = 0
		}
		if _, err := req.encode(); err == nil {
			t.Errorf("accepted zero %s limit", field)
		}
	}
}
