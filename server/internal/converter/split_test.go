package converter

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"miconverter/server/internal/config"
	"miconverter/server/internal/jobs"
)

func TestSplitDetailsStrictAndBounded(t *testing.T) {
	for _, tc := range []struct {
		raw string
		ok  bool
	}{
		{`{"pageCount":1,"partCount":1}`, true}, {`{"pageCount":99999,"partCount":500}`, true},
		{`{"pageCount":1,"partCount":501}`, false}, {`{"pageCount":0,"partCount":1}`, false},
		{`{"pageCount":1,"partCount":0}`, false}, {`{"pageCount":1}`, false},
		{`{"partCount":1}`, false}, {`{"pageCount":1.5,"partCount":1}`, false},
		{`{"pageCount":"1","partCount":1}`, false}, {`{"pageCount":1,"partCount":1,"x":1}`, false},
		{`[]`, false}, {`null`, false},
	} {
		got, err := ValidateSplitDetails(json.RawMessage(tc.raw))
		if (err == nil) != tc.ok {
			t.Errorf("%s: %s %v", tc.raw, got, err)
		}
	}
}

func TestSplitRequestUsesPdfLimitsAndTimeout(t *testing.T) {
	cfg := &config.Config{PdfMaxInputBytes: 100000000, PdfMaxResultsTotalBytes: 300000000,
		PdfTimeout: 300 * time.Second, ImageTimeout: 120 * time.Second, ImageMaxOutputBytes: 1}
	req, err := NewProcessor(nil, cfg).request(jobs.Task{Tool: "pdf-split", InputPath: "/data/input",
		OutputBudget: 250000000, Options: json.RawMessage(`{"mode":"each","tool":"pdf-split"}`),
		Results: []jobs.TaskResult{{ID: [16]byte{1}, Path: "/data/result"}}})
	if err != nil {
		t.Fatal(err)
	}
	if !req.isSplit() || req.isPDF() || req.Timeout != 300*time.Second ||
		req.OutputLimit != 250000000 || req.Limits.PdfMaxResultsTotalBytes != 250000000 {
		t.Fatalf("%+v", req)
	}
	_, err = NewProcessor(nil, cfg).request(jobs.Task{Tool: "pdf-split", InputPath: "/data/input",
		Options: json.RawMessage(`{"mode":"each","tool":"pdf-split"}`)})
	if err == nil {
		t.Fatal("Budget 0 muss abgelehnt werden")
	}
}

func splitSession(t *testing.T, size int, budget int64) (*session, string, *[]Event) {
	t.Helper()
	target := filepath.Join(t.TempDir(), "result")
	if err := os.WriteFile(target, make([]byte, size), 0600); err != nil {
		t.Fatal(err)
	}
	limits := DefaultLimits()
	limits.PdfMaxResultsTotalBytes = budget
	req := Request{Options: json.RawMessage(`{"mode":"each","tool":"pdf-split"}`), Limits: limits,
		Results: []ResultTarget{{ID: resultID, Path: target}}}
	var events []Event
	s := &session{req: req, split: req.isSplit(), onEvent: func(e Event) error { events = append(events, e); return nil }}
	return s, target, &events
}

func TestSplitSessionAcceptsResultAndErrorCode(t *testing.T) {
	s, _, events := splitSession(t, 10, 1000)
	line := `{"kind":"result","id":"` + resultID + `","details":{"pageCount":4,"partCount":2}}`
	if err := s.handle([]byte(line)); err != nil {
		t.Fatal(err)
	}
	e := (*events)[0]
	if e.Kind != KindResult || e.Size != 10 || string(e.Details) != `{"pageCount":4,"partCount":2}` {
		t.Fatalf("%+v", e)
	}
	s, _, events = splitSession(t, 0, 1000)
	if err := s.handle([]byte(`{"kind":"error","id":"` + resultID + `","code":"page-range-invalid"}`)); err != nil {
		t.Fatal(err)
	}
	if (*events)[0].Kind != KindError || (*events)[0].Code != "page-range-invalid" {
		t.Fatalf("%+v", (*events)[0])
	}
}

func TestSplitSessionRejectsBadDetailsAndOversizeResult(t *testing.T) {
	s, _, _ := splitSession(t, 10, 1000)
	bad := `{"kind":"result","id":"` + resultID + `","details":{"pageCount":4}}`
	if err := s.handle([]byte(bad)); err == nil {
		t.Fatal("unvollständige Details akzeptiert")
	}
	s, _, events := splitSession(t, 11, 10)
	ok := `{"kind":"result","id":"` + resultID + `","details":{"pageCount":4,"partCount":2}}`
	if err := s.handle([]byte(ok)); err != nil {
		t.Fatal(err)
	}
	if e := (*events)[0]; e.Kind != KindError || e.Code != "result-too-large" {
		t.Fatalf("%+v", e)
	}
}
