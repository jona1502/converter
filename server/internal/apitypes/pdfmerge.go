package apitypes

// PDF zusammenführen (Werkzeug "pdf-merge"): zwei bis PdfMergeMaxFiles PDFs
// werden in der gesendeten Reihenfolge zu einem Ergebnis-PDF vereint.
const (
	PdfMergeMinFiles = 2
	PdfMergeMaxFiles = 20
	// PdfMergeMaxPages begrenzt die Seitenzahl des Ergebnisses.
	PdfMergeMaxPages = 2000
)

// PdfMergeOptions: Optionen für pdf-merge. Das Werkzeug hat keine
// Einstellungen; das Feld tool ist die einzige erlaubte Eigenschaft.
type PdfMergeOptions struct {
	Tool Tool `json:"tool"`
}

// PdfMergeCapabilities meldet Verfügbarkeit und Grenzen des Zusammenführens.
// maxTotalBytes gilt für die Summe aller Eingaben eines Auftrags.
type PdfMergeCapabilities struct {
	Available      bool  `json:"available"`
	MinFiles       int   `json:"minFiles"`
	MaxFiles       int   `json:"maxFiles"`
	MaxTotalBytes  int64 `json:"maxTotalBytes"`
	MaxOutputBytes int64 `json:"maxOutputBytes"`
	MaxPages       int   `json:"maxPages"`
}

// PdfMergeDetails beschreibt das zusammengeführte PDF.
type PdfMergeDetails struct {
	PageCount   int64 `json:"pageCount"`
	SourceCount int64 `json:"sourceCount"`
}
