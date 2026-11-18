package endpoints

import (
	"miconverter/server/internal/apitypes"
	"miconverter/server/internal/converter"
)

// pdfRotateCapabilities meldet pdf-rotate. Das Werkzeug braucht nur pikepdf.
// Ein Capabilities-Bericht wird nur geschrieben, wenn die PDF-Rundreise der
// Probe gelang (Pflichtformat), daher gilt report.PDF hier immer. Grenzen sind
// die der PDF-Verarbeitung: Eingabe bis PDF_MAX_INPUT_BYTES, Ergebnis bis zum
// PDF-Gesamtbudget.
func (a *API) pdfRotateCapabilities(report converter.Report) apitypes.RotateCapabilities {
	return apitypes.RotateCapabilities{
		Available:      report.PDF,
		MaxFileBytes:   a.cfg.PdfMaxInputBytes,
		MaxOutputBytes: a.cfg.PdfMaxResultsTotalBytes,
		Angles:         apitypes.PdfRotateAngles(),
	}
}
