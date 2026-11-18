package apitypes

import "miconverter/server/internal/validation"

// Typen des Werkzeugs image-pdf („Bild zu PDF“): ein Auftrag erhält ein
// ZIP-Bündel mit 1..n Bildern (Vertrag: api/openapi.json, Eingabeformat zip)
// und erzeugt genau ein PDF mit einem Bild pro Seite.

// ImagePdfPageSize: Feld pageSize der image-pdf-Optionen (Inline-Enum).
type ImagePdfPageSize string

const (
	ImagePdfPageA4     ImagePdfPageSize = "a4"
	ImagePdfPageLetter ImagePdfPageSize = "letter"
	// ImagePdfPageFit: Seite so groß wie das Bild (plus Rand).
	ImagePdfPageFit ImagePdfPageSize = "fit"
)

func ImagePdfPageSizes() []ImagePdfPageSize {
	return []ImagePdfPageSize{ImagePdfPageA4, ImagePdfPageLetter, ImagePdfPageFit}
}

// ImagePdfOrientation: Feld orientation (Inline-Enum). auto richtet jede
// Seite nach dem Seitenverhältnis ihres Bildes aus.
type ImagePdfOrientation string

const (
	ImagePdfOrientationAuto      ImagePdfOrientation = "auto"
	ImagePdfOrientationPortrait  ImagePdfOrientation = "portrait"
	ImagePdfOrientationLandscape ImagePdfOrientation = "landscape"
)

func ImagePdfOrientations() []ImagePdfOrientation {
	return []ImagePdfOrientation{ImagePdfOrientationAuto, ImagePdfOrientationPortrait, ImagePdfOrientationLandscape}
}

// ImagePdfMargin: Feld margin (Inline-Enum); none 0 mm, small 10 mm, medium 20 mm.
type ImagePdfMargin string

const (
	ImagePdfMarginNone   ImagePdfMargin = "none"
	ImagePdfMarginSmall  ImagePdfMargin = "small"
	ImagePdfMarginMedium ImagePdfMargin = "medium"
)

func ImagePdfMargins() []ImagePdfMargin {
	return []ImagePdfMargin{ImagePdfMarginNone, ImagePdfMarginSmall, ImagePdfMarginMedium}
}

type ImagePdfOptions struct {
	Tool        Tool                                     `json:"tool"`
	PageSize    validation.Optional[ImagePdfPageSize]    `json:"pageSize,omitzero" strict:"notnull"`
	Orientation validation.Optional[ImagePdfOrientation] `json:"orientation,omitzero" strict:"notnull"`
	Margin      validation.Optional[ImagePdfMargin]      `json:"margin,omitzero" strict:"notnull"`
}

// ImagePdfCapabilities meldet Verfügbarkeit und Grenzen von image-pdf.
type ImagePdfCapabilities struct {
	Available      bool  `json:"available"`
	MaxImages      int64 `json:"maxImages"`
	MaxImageBytes  int64 `json:"maxImageBytes"`
	MaxTotalBytes  int64 `json:"maxTotalBytes"`
	MaxOutputBytes int64 `json:"maxOutputBytes"`
}

// ImagePdfDetails beschreibt das erzeugte PDF (eine Seite je Bild).
type ImagePdfDetails struct {
	PageCount int64 `json:"pageCount"`
}
