package config

import "testing"

func TestPdfRenderMaxPagesDefaultsAndOverride(t *testing.T) {
	c := mustLoad(t, map[string]string{"CONVERTER_ENVIRONMENT": "test"})
	if c.PdfRenderMaxPages != 100 {
		t.Fatalf("PdfRenderMaxPages = %d, erwartet 100", c.PdfRenderMaxPages)
	}
	c = mustLoad(t, map[string]string{"CONVERTER_ENVIRONMENT": "test", "CONVERTER_PDF_RENDER_MAX_PAGES": "25"})
	if c.PdfRenderMaxPages != 25 {
		t.Fatalf("PdfRenderMaxPages = %d, erwartet 25", c.PdfRenderMaxPages)
	}
}

func TestPdfRenderMaxPagesMustBePositive(t *testing.T) {
	for _, value := range []string{"0", "-3", "abc"} {
		if _, err := Load(env(map[string]string{"CONVERTER_ENVIRONMENT": "test", "CONVERTER_PDF_RENDER_MAX_PAGES": value})); err == nil {
			t.Errorf("PDF_RENDER_MAX_PAGES=%q muss abgelehnt werden", value)
		}
	}
}
