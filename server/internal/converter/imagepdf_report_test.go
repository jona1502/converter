package converter

import (
	"testing"
	"time"
)

func TestImagePdfAvailableNeedsDecodersAndPdfWriter(t *testing.T) {
	report, err := parseProbe([]byte(probeOK), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !report.ImagePdfAvailable() {
		t.Fatal("vollständige Probe muss Bild zu PDF freigeben")
	}
	noPdf := report
	noPdf.PDF = false
	if noPdf.ImagePdfAvailable() {
		t.Fatal("ohne PDF-Schreiber nicht verfügbar")
	}
	for _, missing := range imagePdfInputs {
		partial := report
		partial.InputFormats = nil
		for _, f := range report.InputFormats {
			if f != missing {
				partial.InputFormats = append(partial.InputFormats, f)
			}
		}
		if partial.ImagePdfAvailable() {
			t.Errorf("ohne %s nicht verfügbar", missing)
		}
	}
}
