package converter

import (
	"context"
	"encoding/json"
	"miconverter/server/internal/jobs"
	"os"
	"testing"
	"time"
)

func TestRealPythonMarkdownPipeline(t *testing.T) {
	r := realRunner(t)
	report, err := r.Probe(context.Background())
	if err != nil || !report.Markdown.Available {
		t.Fatalf("probe=%+v err=%v", report, err)
	}
	for _, tc := range []struct {
		name, source, code string
		outputLimit        int64
	}{
		{"valid", "# Grüße\n\nMarkdown **PDF**.", "", 20971520},
		{"invalid", "hello\x00", "decode-failed", 20971520},
		{"output-bound", "# Test", "result-too-large", 100},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := requestFor(t)
			req.Options = json.RawMessage(`{"tool":"markdown-pdf"}`)
			req.Timeout = 120 * time.Second
			req.OutputLimit = 20971520
			req.Limits.MarkdownMaxOutputBytes = tc.outputLimit
			if err := os.WriteFile(req.Source, []byte(tc.source), 0600); err != nil {
				t.Fatal(err)
			}
			var code string
			var details json.RawMessage
			out, err := r.Run(context.Background(), req, func(e Event) error {
				if e.Kind == KindResult {
					details = e.Details
				}
				if e.Kind == KindError {
					code = e.Code
				}
				return nil
			})
			if err != nil || out.ErrorCode != "" || code != tc.code {
				t.Fatalf("out=%+v code=%s err=%v", out, code, err)
			}
			data, err := os.ReadFile(req.Results[0].Path)
			if err != nil {
				t.Fatal(err)
			}
			if tc.code == "" {
				if !jobs.IsPDF(data) || string(details) != `{"pageCount":1}` {
					t.Fatalf("details=%s PDF=%v", details, jobs.IsPDF(data))
				}
			} else if len(data) != 0 {
				t.Fatalf("failed output has %d bytes", len(data))
			}
		})
	}
}
