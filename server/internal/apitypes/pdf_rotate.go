package apitypes

import "miconverter/server/internal/validation"

// Werkzeug pdf-rotate: setzt /Rotate der gewählten Seiten einer PDF.

// PdfRotateAll ist der Standardwert von pages: alle Seiten.
const PdfRotateAll = "all"

// PdfRotateAngles sind die erlaubten Drehwinkel (Uhrzeigersinn, Grad).
func PdfRotateAngles() []int { return []int{90, 180, 270} }

// PdfRotateOptions: Optionen für pdf-rotate. pages ist "all" oder eine Liste
// einzelner Seiten und Bereiche wie "1-3,5" (1-basiert).
type PdfRotateOptions struct {
	Tool  Tool                        `json:"tool"`
	Angle int                         `json:"angle"`
	Pages validation.Optional[string] `json:"pages,omitzero" strict:"notnull"`
}

// RotateCapabilities meldet Verfügbarkeit und Grenzen von pdf-rotate.
type RotateCapabilities struct {
	Available      bool  `json:"available"`
	MaxFileBytes   int64 `json:"maxFileBytes"`
	MaxOutputBytes int64 `json:"maxOutputBytes"`
	Angles         []int `json:"angles"`
}

// PdfRotateDetails: details eines pdf-rotate-Ergebnisses.
type PdfRotateDetails struct {
	PageCount    int64 `json:"pageCount"`
	RotatedPages int64 `json:"rotatedPages"`
}

// PdfRotate liefert die Optionen von pdf-rotate, falls gesetzt.
func (o JobOptions) PdfRotate() (*PdfRotateOptions, bool) {
	v, ok := o.Value.(*PdfRotateOptions)
	return v, ok
}
