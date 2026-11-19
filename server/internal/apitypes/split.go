package apitypes

import "miconverter/server/internal/validation"

// Werkzeug pdf-split: PDF in Teil-PDFs aufteilen (Bereiche oder je Seite).

const (
	ToolPDFSplit         Tool                = "pdf-split"
	ProcPageRangeInvalid ProcessingErrorCode = "page-range-invalid"
)

// SplitMode: Feld mode der Teilen-Optionen (Inline-Enum).
type SplitMode string

const (
	SplitModeRanges SplitMode = "ranges"
	SplitModeEach   SplitMode = "each"
)

func SplitModes() []SplitMode { return []SplitMode{SplitModeRanges, SplitModeEach} }

// SplitOptions: mode "ranges" braucht ranges (z. B. "1-3,5,7-"), mode "each"
// erlaubt kein ranges. Die Syntax prüft endpoints (Paket pagerange).
type SplitOptions struct {
	Tool   Tool                        `json:"tool"`
	Mode   SplitMode                   `json:"mode"`
	Ranges validation.Optional[string] `json:"ranges,omitzero" strict:"notnull"`
}

// PdfSplitCapabilities meldet Verfügbarkeit und Grenzen von pdf-split.
type PdfSplitCapabilities struct {
	Available      bool  `json:"available"`
	MaxFileBytes   int64 `json:"maxFileBytes"`
	MaxOutputBytes int64 `json:"maxOutputBytes"`
	MaxParts       int64 `json:"maxParts"`
}

// SplitDetails: details eines pdf-split-Ergebnisses. pageCount sind die Seiten
// der Eingabe, partCount die Teil-PDFs (im ZIP bzw. 1 bei einer einzelnen PDF).
type SplitDetails struct {
	PageCount int64 `json:"pageCount"`
	PartCount int64 `json:"partCount"`
}
