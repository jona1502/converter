package config

import "testing"

func TestImagePdfLimitsDefaultsAndOverrides(t *testing.T) {
	c := mustLoad(t, map[string]string{"CONVERTER_ENVIRONMENT": "test"})
	if c.ImagePdfMaxImages != 30 || c.ImagePdfMaxInputBytes != 104_857_600 {
		t.Fatalf("Standardwerte: %d %d", c.ImagePdfMaxImages, c.ImagePdfMaxInputBytes)
	}
	c = mustLoad(t, map[string]string{
		"CONVERTER_ENVIRONMENT":               "test",
		"CONVERTER_IMAGE_PDF_MAX_IMAGES":      "5",
		"CONVERTER_IMAGE_PDF_MAX_INPUT_BYTES": "9000000",
	})
	if c.ImagePdfMaxImages != 5 || c.ImagePdfMaxInputBytes != 9_000_000 {
		t.Fatalf("Überschreibung: %d %d", c.ImagePdfMaxImages, c.ImagePdfMaxInputBytes)
	}
}

func TestImagePdfLimitsInUploadReservation(t *testing.T) {
	c := mustLoad(t, map[string]string{
		"CONVERTER_ENVIRONMENT":               "test",
		"CONVERTER_IMAGE_PDF_MAX_INPUT_BYTES": "900000000",
	})
	if got := c.MaxUploadInputBytes(); got != 900_000_000 {
		t.Fatalf("MaxUploadInputBytes = %d", got)
	}
}
