package endpoints

import (
	"encoding/json"
	"slices"
	"testing"

	"miconverter/server/internal/config"
	"miconverter/server/internal/converter"
)

func TestSplitCapabilitiesFollowPDFProbeAndConfig(t *testing.T) {
	cfg := &config.Config{PdfMaxInputBytes: 100_000_000, PdfMaxResultsTotalBytes: 300_000_000}
	got := splitCapabilities(cfg, converter.Report{PDF: true})
	if !got.Available || got.MaxFileBytes != 100_000_000 || got.MaxOutputBytes != 300_000_000 || got.MaxParts != 500 {
		t.Fatalf("%+v", got)
	}
	if splitCapabilities(cfg, converter.Report{PDF: false}).Available {
		t.Fatal("ohne PDF-Rundreise darf pdf-split nicht verfügbar sein")
	}
}

func TestSplitUploadAndCapabilities(t *testing.T) {
	f := fixture(t)
	markdownReport(t, f, true) // schreibt einen Bericht mit pdf:true
	b, c := body(t, `{"tool":"pdf-split","mode":"ranges","ranges":"1-2,4"}`, []byte("%PDF-1.7\n%test"))
	r := f.request("POST", "/jobs", b, c)
	if r.Code != 202 {
		t.Fatalf("%d %s", r.Code, r.Body.String())
	}
	var j struct {
		Tool    string
		Input   struct{ Format string }
		Results []struct {
			Mime, DownloadName string
			Level              *string
		}
	}
	if err := json.Unmarshal(r.Body.Bytes(), &j); err != nil {
		t.Fatal(err)
	}
	if j.Tool != "pdf-split" || j.Input.Format != "pdf" || len(j.Results) != 1 || j.Results[0].Mime != "application/zip" || j.Results[0].Level != nil {
		t.Fatalf("%+v", j)
	}
	r = f.request("GET", "/capabilities", nil, "")
	var caps struct {
		Tools    []string
		PdfSplit struct {
			Available                              bool
			MaxFileBytes, MaxOutputBytes, MaxParts int
		}
	}
	if err := json.Unmarshal(r.Body.Bytes(), &caps); err != nil {
		t.Fatal(err)
	}
	if r.Code != 200 || !slices.Contains(caps.Tools, "pdf-split") || !caps.PdfSplit.Available || caps.PdfSplit.MaxParts != 500 {
		t.Fatalf("%d %s", r.Code, r.Body.String())
	}
}

func TestSplitRejectsNonPDFAndInvalidRanges(t *testing.T) {
	f := fixture(t)
	markdownReport(t, f, true)
	b, c := body(t, `{"tool":"pdf-split","mode":"each"}`, []byte("kein pdf"))
	if r := f.request("POST", "/jobs", b, c); r.Code != 415 {
		t.Fatalf("%d %s", r.Code, r.Body.String())
	}
	b, c = body(t, `{"tool":"pdf-split","mode":"ranges","ranges":"3-1"}`, []byte("%PDF-1.7\n"))
	if r := f.request("POST", "/jobs", b, c); r.Code != 422 {
		t.Fatalf("%d %s", r.Code, r.Body.String())
	}
}
