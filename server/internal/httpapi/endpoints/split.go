package endpoints

import (
	"path/filepath"
	"slices"
	"time"

	"miconverter/server/internal/apitypes"
	"miconverter/server/internal/config"
	"miconverter/server/internal/converter"
	"miconverter/server/internal/httpapi"
	"miconverter/server/internal/pagerange"
)

// splitCapabilities meldet pdf-split. Das Werkzeug braucht dieselbe bestätigte
// PDF-Rundreise (pikepdf) wie pdf-compress; ohne sie ist es nicht verfügbar.
func splitCapabilities(cfg *config.Config, report converter.Report) apitypes.PdfSplitCapabilities {
	return apitypes.PdfSplitCapabilities{
		Available:      report.PDF,
		MaxFileBytes:   cfg.PdfMaxInputBytes,
		MaxOutputBytes: cfg.PdfMaxResultsTotalBytes,
		MaxParts:       pagerange.MaxRanges,
	}
}

// addSplitCapabilities ergänzt den Teil pdfSplit und entfernt das Werkzeug aus
// der Liste, wenn es nicht verfügbar ist.
func (a *API) addSplitCapabilities(out *apitypes.Capabilities, report converter.Report) {
	out.PdfSplit = splitCapabilities(a.cfg, report)
	if !out.PdfSplit.Available {
		out.Tools = slices.DeleteFunc(out.Tools, func(tool apitypes.Tool) bool { return tool == apitypes.ToolPDFSplit })
	}
}

// requireSplit lehnt Aufträge ab, solange der Konverter pdf-split nicht bestätigt hat.
func (a *API) requireSplit() error {
	report, err := converter.LoadReport(filepath.Join(a.cfg.StorageDir, converter.ReportFile), time.Now().UTC(), 15*time.Minute)
	if err != nil || !report.PDF {
		return httpapi.NewError(503, apitypes.CodeServiceUnavailable, "PDF-Teilen ist nicht verfügbar.")
	}
	return nil
}
