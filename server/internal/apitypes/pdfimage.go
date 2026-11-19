package apitypes

import "miconverter/server/internal/validation"

// PdfImageFormat: Feld format der pdf-to-image-Optionen (Inline-Enum).
type PdfImageFormat string

const (
	PdfImagePNG  PdfImageFormat = "png"
	PdfImageJPEG PdfImageFormat = "jpeg"
	PdfImageWebP PdfImageFormat = "webp"
)

func PdfImageFormats() []PdfImageFormat {
	return []PdfImageFormat{PdfImagePNG, PdfImageJPEG, PdfImageWebP}
}

// Auflösungsgrenzen von pdf-to-image in dpi (Vertrag und Konverter stimmen überein).
const (
	PdfImageMinDPI     = 72
	PdfImageMaxDPI     = 300
	PdfImageDefaultDPI = 150
)

// PdfImageOptions sind die Optionen von pdf-to-image. Pages ist "all" oder eine
// Liste wie "1-3,5" (Seiten ab 1); der Server normalisiert sie beim Annehmen.
type PdfImageOptions struct {
	Tool    Tool                         `json:"tool"`
	Format  PdfImageFormat               `json:"format"`
	Dpi     validation.Optional[int]     `json:"dpi,omitzero" strict:"notnull"`
	Pages   validation.Optional[string]  `json:"pages,omitzero" strict:"notnull"`
	Quality validation.Optional[float64] `json:"quality,omitzero" strict:"notnull"`
}

// PdfImageCapabilities meldet Verfügbarkeit (echte PDFium-Probe) und Grenzen.
type PdfImageCapabilities struct {
	Available      bool             `json:"available"`
	Formats        []PdfImageFormat `json:"formats"`
	QualityFormats []PdfImageFormat `json:"qualityFormats"`
	MinDpi         int              `json:"minDpi"`
	MaxDpi         int              `json:"maxDpi"`
	DefaultDpi     int              `json:"defaultDpi"`
	MaxFileBytes   int64            `json:"maxFileBytes"`
	MaxOutputBytes int64            `json:"maxOutputBytes"`
	MaxPages       int64            `json:"maxPages"`
	MaxPixels      int64            `json:"maxPixels"`
}

// PdfImageDetails beschreibt das einzelne Ergebnis: pageCount gerenderte Seiten,
// sourcePageCount Seiten des Dokuments, archive true bei ZIP.
type PdfImageDetails struct {
	PageCount       int64 `json:"pageCount"`
	SourcePageCount int64 `json:"sourcePageCount"`
	Archive         bool  `json:"archive"`
}

// PdfImage liefert die pdf-to-image-Optionen, falls gesetzt.
func (o JobOptions) PdfImage() (*PdfImageOptions, bool) {
	v, ok := o.Value.(*PdfImageOptions)
	return v, ok
}
