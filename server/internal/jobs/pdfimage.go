package jobs

import (
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// PDF zu Bild: Seitenauswahl, Ergebnisnamen und Ergebniszeile. Dieselben
// Regeln prüft der Konverter defensiv (converter/converter/pagespec.py).

const (
	// ZipMIME ist der Medientyp des Seitenarchivs.
	ZipMIME = "application/zip"
	// MaxPageSelectionText und MaxPageNumber begrenzen die Eingabe.
	MaxPageSelectionText = 200
	MaxPageNumber        = 9999
)

// PDFImageExtensions und PDFImageMIME je Ausgabeformat von pdf-to-image.
var (
	PDFImageExtensions = map[string]string{"png": "png", "jpeg": "jpg", "webp": "webp"}
	PDFImageMIME       = map[string]string{"png": "image/png", "jpeg": "image/jpeg", "webp": "image/webp"}
)

// ErrInvalidPageSelection meldet eine fehlerhafte Seitenauswahl.
var ErrInvalidPageSelection = errors.New("jobs: ungültige Seitenauswahl")

var pageToken = regexp.MustCompile(`^([0-9]{1,4})(?:-([0-9]{1,4}))?$`)

// ParsePageSelection liest "all" (all=true) oder eine Liste wie "1-3,5".
// Ergebnis: aufsteigende, eindeutige Seitennummern ab 1.
func ParsePageSelection(text string) (pages []int, all bool, err error) {
	if text == "" || len(text) > MaxPageSelectionText {
		return nil, false, ErrInvalidPageSelection
	}
	if text == "all" {
		return nil, true, nil
	}
	seen := map[int]bool{}
	for token := range strings.SplitSeq(text, ",") {
		match := pageToken.FindStringSubmatch(token)
		if match == nil {
			return nil, false, ErrInvalidPageSelection
		}
		first, _ := strconv.Atoi(match[1])
		last := first
		if match[2] != "" {
			last, _ = strconv.Atoi(match[2])
		}
		if first < 1 || last < first || last > MaxPageNumber {
			return nil, false, ErrInvalidPageSelection
		}
		for page := first; page <= last; page++ {
			seen[page] = true
		}
	}
	pages = make([]int, 0, len(seen))
	for page := range seen {
		pages = append(pages, page)
	}
	slices.Sort(pages)
	return pages, false, nil
}

// NormalizePages liefert die kanonische Kurzschreibweise ("1-3,5") für
// aufsteigende, eindeutige Seiten (mindestens eine).
func NormalizePages(pages []int) string {
	var parts []string
	start, previous := pages[0], pages[0]
	flush := func() {
		if start == previous {
			parts = append(parts, strconv.Itoa(start))
		} else {
			parts = append(parts, fmt.Sprintf("%d-%d", start, previous))
		}
	}
	for _, page := range pages[1:] {
		if page == previous+1 {
			previous = page
			continue
		}
		flush()
		start, previous = page, page
	}
	flush()
	return strings.Join(parts, ",")
}

// PdfImageDownloadName: Einzelbild "<Stamm>-seite-<n>.<ext>".
func PdfImageDownloadName(originalName, format string, page int) string {
	return fmt.Sprintf("%s-seite-%d.%s", CleanBase(originalName, PDFFallbackBase), page, PDFImageExtensions[format])
}

// PdfImageArchiveName: Archiv "<Stamm>-bilder.zip".
func PdfImageArchiveName(originalName string) string {
	return CleanBase(originalName, PDFFallbackBase) + "-bilder.zip"
}

// pdfImageRow erzeugt die einzige Ergebniszeile: Archiv oder Einzelbild.
func (u Upload) pdfImageRow(originalName string) ([]resultRow, error) {
	mime, ok := PDFImageMIME[u.OutputFormat]
	if !ok {
		return nil, errors.New("jobs: Bildformat von pdf-to-image nicht erzeugbar")
	}
	if u.PDFArchive {
		return []resultRow{{ordinal: 0, mime: ZipMIME, name: PdfImageArchiveName(originalName)}}, nil
	}
	if u.PDFPage < 1 || u.PDFPage > MaxPageNumber {
		return nil, errors.New("jobs: Einzelbild ohne gültige Seite")
	}
	return []resultRow{{ordinal: 0, mime: mime, name: PdfImageDownloadName(originalName, u.OutputFormat, u.PDFPage)}}, nil
}
