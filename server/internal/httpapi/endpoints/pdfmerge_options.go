package endpoints

import (
	"miconverter/server/internal/apitypes"
	"miconverter/server/internal/jobs"
)

// parsePdfMergeOptions prüft pdf-merge. Das Werkzeug hat keine
// Einstellungen; unbekannte Felder lehnt bereits die strikte Dekodierung ab.
func parsePdfMergeOptions(_ *apitypes.PdfMergeOptions) (options, error) {
	canonical, err := jobs.CanonicalJSON(map[string]any{"tool": "pdf-merge"})
	return options{tool: "pdf-merge", canonical: canonical, format: "pdf"}, err
}
