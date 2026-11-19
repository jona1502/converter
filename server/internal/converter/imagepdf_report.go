package converter

import "slices"

// imagePdfInputs sind die Bildformate, die Bild zu PDF dekodieren muss.
var imagePdfInputs = []string{"jpeg", "png", "webp", "gif", "bmp"}

// ImagePdfAvailable: Bild zu PDF braucht alle fünf Bilddecoder und den
// PDF-Schreiber (pikepdf). Beides bestätigt die echte Probe des Konverters,
// der Bericht braucht daher kein eigenes Feld.
func (r Report) ImagePdfAvailable() bool {
	if !r.PDF {
		return false
	}
	inputs, _ := r.ImageFormats()
	for _, format := range imagePdfInputs {
		if !slices.Contains(inputs, format) {
			return false
		}
	}
	return true
}
