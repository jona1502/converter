package jobs

// Werkzeug pdf-rotate: Benennung und Arbeitsreserve.

// rotateOverhead deckt die neu geschriebene Objekttabelle und Kopfdaten ab.
const rotateOverhead = 1 << 20

// PDFRotateDownloadName: "<Basis>-gedreht.pdf"; die Basis wird wie bei allen
// Werkzeugen bereinigt (kein Pfad, keine Steuerzeichen).
func PDFRotateDownloadName(originalName string) string {
	return CleanBase(originalName, PDFFallbackBase) + "-gedreht.pdf"
}

// RotateWorkingBytes ist die Arbeitsreserve für eine gedrehte PDF. Die
// Ausgabe ist etwa so groß wie die Eingabe; doppelte Größe plus Puffer
// genügt, ohne das volle PDF-Gesamtbudget zu blockieren.
func RotateWorkingBytes(inputSize, ceiling int64) int64 {
	return max(1, min(ceiling, 2*inputSize+rotateOverhead))
}
