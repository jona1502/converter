package jobs

// ImagePdfFallbackBase ist der Namensstamm, wenn der Bündelname unbrauchbar ist.
const ImagePdfFallbackBase = "bilder"

// ImagePdfDownloadName: "<bereinigter Bündelname>.pdf".
func ImagePdfDownloadName(originalName string) string {
	return CleanBase(originalName, ImagePdfFallbackBase) + ".pdf"
}
