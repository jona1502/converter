package jobs

import (
	"strings"
	"unicode"
)

// Anzeige- und Downloadnamen, Portierung von app/jobs/naming.py (Vertrag §4
// und §5 „Downloadnamen“). Namen dienen nur der Anzeige und dem
// Content-Disposition-Header – nie einem Dateipfad. Längen zählen wie in
// Python in Codepoints.

const (
	MaxBaseLength     = 100
	ImageFallbackBase = "bild"
	PDFFallbackBase   = "dokument"
)

// OutputExtensions und OutputMIME je Ausgabeformat (domain.py).
var (
	OutputExtensions = map[string]string{"jpeg": "jpg", "png": "png", "webp": "webp", "bmp": "bmp", "ico": "ico"}
	OutputMIME       = map[string]string{
		"jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp",
		"bmp": "image/bmp", "ico": "image/x-icon",
	}
)

const PDFMIME = "application/pdf"

func isControl(r rune) bool { return r <= 0x1f || (r >= 0x7f && r <= 0x9f) }

func isBidi(r rune) bool {
	return r == 0x061c || r == 0x200e || r == 0x200f ||
		(r >= 0x202a && r <= 0x202e) || (r >= 0x2066 && r <= 0x2069)
}

func isForbidden(r rune) bool { return strings.ContainsRune(`/\:*?"<>|`, r) }

// isPySpace entspricht \s in Pythons re für str (str.isspace). Steuerzeichen
// \x1c–\x1f sind dort ebenfalls Leerraum, werden aber vorher entfernt.
func isPySpace(r rune) bool {
	return unicode.IsSpace(r) || (r >= 0x1c && r <= 0x1f)
}

func sanitize(part string) string {
	var b strings.Builder
	pendingSpace := false
	for _, r := range part {
		// Reihenfolge wie Python: Steuerzeichen (auch \t, \n) und Bidi
		// entfernen, dann verbotene Zeichen ersetzen, dann Leerraum
		// zusammenfassen.
		if isControl(r) || isBidi(r) {
			continue
		}
		if isForbidden(r) {
			r = '_'
		}
		if isPySpace(r) {
			pendingSpace = true
			continue
		}
		if pendingSpace {
			b.WriteByte(' ')
			pendingSpace = false
		}
		b.WriteRune(r)
	}
	if pendingSpace {
		b.WriteByte(' ')
	}
	return trimEdges(b.String())
}

func isEdge(r rune) bool { return r == '.' || isPySpace(r) }

func trimEdges(s string) string { return strings.TrimFunc(s, isEdge) }

func truncate(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return strings.TrimRightFunc(string(runes[:limit]), isEdge)
}

func stripExtension(name string) string {
	if dot := strings.LastIndexByte(name, '.'); dot > 0 {
		return name[:dot]
	}
	return name
}

var reservedNames = func() map[string]bool {
	m := map[string]bool{"con": true, "prn": true, "aux": true, "nul": true}
	for d := '1'; d <= '9'; d++ {
		m["com"+string(d)] = true
		m["lpt"+string(d)] = true
	}
	return m
}()

func avoidReserved(base string) string {
	if reservedNames[strings.ToLower(base)] && isASCII(base) {
		return "_" + base
	}
	return base
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return false
		}
	}
	return true
}

// CleanBase liefert den bereinigten Namensstamm ohne Endung.
func CleanBase(originalName, fallback string) string {
	base := truncate(sanitize(stripExtension(originalName)), MaxBaseLength)
	if base == "" {
		base = fallback
	}
	return avoidReserved(base)
}

// DisplayName ist der bereinigte Originalname mit Endung (nur Anzeige).
func DisplayName(originalName, fallback string) string {
	base := CleanBase(originalName, fallback)
	extension := ""
	if dot := strings.LastIndexByte(originalName, '.'); dot > 0 {
		extension = truncate(sanitize(originalName[dot+1:]), 16)
	}
	if extension == "" {
		return base
	}
	return base + "." + extension
}

// ImageDownloadName wie naming.image_download_name. output muss ein
// Ausgabeformat sein (jpeg, png, webp, bmp, ico).
func ImageDownloadName(originalName, tool, inputFormat, outputFormat string) string {
	suffix := ""
	switch tool {
	case "image-compress":
		suffix = "komprimiert"
	case "image-resize":
		suffix = "skaliert"
	default:
		// Konverter: Suffix nur, wenn sich das Format nicht ändert.
		if inputFormat == outputFormat {
			suffix = "konvertiert"
		}
	}
	name := CleanBase(originalName, ImageFallbackBase)
	if suffix != "" {
		name += "-" + suffix
	}
	return name + "." + OutputExtensions[outputFormat]
}

// PDFDownloadName wie naming.pdf_download_name.
func PDFDownloadName(originalName, level string) string {
	return CleanBase(originalName, PDFFallbackBase) + "-" + level + ".pdf"
}
