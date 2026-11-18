package endpoints

import (
	"errors"
	"io"
	"path/filepath"
	"strings"
	"time"

	"miconverter/server/internal/apitypes"
	"miconverter/server/internal/converter"
	"miconverter/server/internal/httpapi"
	"miconverter/server/internal/jobs"
)

// imagePdfLimits: Grenzen eines Bild-zu-PDF-Bündels aus der Konfiguration.
func (a *API) imagePdfLimits() jobs.BundleLimits {
	return jobs.BundleLimits{
		MaxImages:     a.cfg.ImagePdfMaxImages,
		MaxImageBytes: a.cfg.ImageMaxInputBytes,
		MaxTotalBytes: a.cfg.ImagePdfMaxInputBytes,
	}
}

// requireImagePdf liefert 503, solange die Konverter-Probe Bild zu PDF nicht bestätigt.
func (a *API) requireImagePdf() error {
	report, err := converter.LoadReport(filepath.Join(a.cfg.StorageDir, converter.ReportFile), time.Now().UTC(), 15*time.Minute)
	if err != nil || !report.ImagePdfAvailable() {
		return httpapi.NewError(503, apitypes.CodeServiceUnavailable, "Bild zu PDF ist nicht verfügbar.")
	}
	return nil
}

// checkImagePdfUpload prüft die gespoolte Eingabe: ZIP-Endung und Bündelstruktur.
// Dekodierung und Pixelgrenzen prüft der Konverter im Worker.
func (a *API) checkImagePdfUpload(file io.ReaderAt, size int64, originalName string) error {
	unsupported := httpapi.NewError(415, apitypes.CodeUnsupportedType, "Ein ZIP-Bündel mit Bildern (JPEG, PNG, WebP, GIF, BMP) wird benötigt.")
	if strings.ToLower(filepath.Ext(originalName)) != ".zip" {
		return unsupported
	}
	_, err := jobs.ValidateImageBundle(file, size, a.imagePdfLimits())
	switch {
	case err == nil:
		return nil
	case errors.Is(err, jobs.ErrBundleLimit):
		return httpapi.NewError(413, apitypes.CodeFileTooLarge, "Das Bildbündel überschreitet die Grenzen.")
	default:
		return unsupported
	}
}

// imagePdfCapabilities beschreibt Verfügbarkeit und Grenzen für /capabilities.
func (a *API) imagePdfCapabilities(report converter.Report) apitypes.ImagePdfCapabilities {
	if !report.ImagePdfAvailable() {
		return apitypes.ImagePdfCapabilities{}
	}
	return apitypes.ImagePdfCapabilities{
		Available: true, MaxImages: a.cfg.ImagePdfMaxImages, MaxImageBytes: a.cfg.ImageMaxInputBytes,
		MaxTotalBytes: a.cfg.ImagePdfMaxInputBytes, MaxOutputBytes: a.cfg.ImageMaxOutputBytes,
	}
}
