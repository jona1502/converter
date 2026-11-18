package endpoints

import (
	"math"
	"slices"

	"miconverter/server/internal/apitypes"
	"miconverter/server/internal/jobs"
)

// parsePdfImageOptions prüft pdf-to-image und liefert das kanonische JSON mit
// Standardwerten (150 dpi, alle Seiten, Qualität 0,85). Die Seitenauswahl wird
// normalisiert. Genau eine ausdrücklich gewählte Seite ergibt ein Einzelbild,
// jede andere Auswahl (auch "all") ein ZIP; so stehen Name und Medientyp des
// Ergebnisses schon bei der Annahme fest. quality wirkt nur bei jpeg/webp.
func parsePdfImageOptions(input *apitypes.PdfImageOptions) (options, error) {
	if !slices.Contains(apitypes.PdfImageFormats(), input.Format) {
		return options{}, invalidOptions()
	}
	dpi := input.Dpi.Or(apitypes.PdfImageDefaultDPI)
	quality := input.Quality.Or(.85)
	if dpi < apitypes.PdfImageMinDPI || dpi > apitypes.PdfImageMaxDPI ||
		math.IsNaN(quality) || math.IsInf(quality, 0) || quality < 0 || quality > 1 {
		return options{}, invalidOptions()
	}
	pages, all, err := jobs.ParsePageSelection(input.Pages.Or("all"))
	if err != nil {
		return options{}, invalidOptions()
	}
	text, count, page := "all", 0, 0
	if !all {
		text, count = jobs.NormalizePages(pages), len(pages)
		if count == 1 {
			page = pages[0]
		}
	}
	canonical, err := jobs.CanonicalJSON(map[string]any{
		"tool": "pdf-to-image", "format": string(input.Format), "dpi": dpi, "pages": text, "quality": quality,
	})
	return options{tool: "pdf-to-image", canonical: canonical, format: string(input.Format),
		pdfArchive: all || count != 1, pdfPage: page, pageCount: count}, err
}
