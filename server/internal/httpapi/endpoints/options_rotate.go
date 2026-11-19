package endpoints

import (
	"regexp"
	"slices"
	"strconv"
	"strings"

	"miconverter/server/internal/apitypes"
	"miconverter/server/internal/jobs"
)

// pdfRotatePages: "all" oder eine Liste aus Seiten und Bereichen ohne
// Leerzeichen, Vorzeichen oder führende Nullen ("1-3,5"). Die Python-Seite
// prüft dieselbe Grammatik erneut.
var pdfRotatePages = regexp.MustCompile(`^[1-9][0-9]{0,6}(-[1-9][0-9]{0,6})?(,[1-9][0-9]{0,6}(-[1-9][0-9]{0,6})?)*$`)

const maxPdfRotatePagesSpec = 256

// validPdfRotatePages prüft Syntax und Bereichsrichtung; ob die Seiten im
// Dokument existieren, steht erst nach dem Öffnen der PDF fest.
func validPdfRotatePages(spec string) bool {
	if spec == apitypes.PdfRotateAll {
		return true
	}
	if len(spec) > maxPdfRotatePagesSpec || !pdfRotatePages.MatchString(spec) {
		return false
	}
	for _, part := range strings.Split(spec, ",") {
		first, last, isRange := strings.Cut(part, "-")
		start, _ := strconv.Atoi(first)
		end := start
		if isRange {
			end, _ = strconv.Atoi(last)
		}
		if start > end {
			return false
		}
	}
	return true
}

// parsePdfRotateOptions prüft pdf-rotate; Standard ist "alle Seiten".
func parsePdfRotateOptions(rotate *apitypes.PdfRotateOptions) (options, error) {
	pages := rotate.Pages.Or(apitypes.PdfRotateAll)
	if !slices.Contains(apitypes.PdfRotateAngles(), rotate.Angle) || !validPdfRotatePages(pages) {
		return options{}, invalidOptions()
	}
	canonical, err := jobs.CanonicalJSON(map[string]any{"tool": "pdf-rotate", "angle": rotate.Angle, "pages": pages})
	return options{tool: "pdf-rotate", canonical: canonical, format: "pdf"}, err
}
