package jobs

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"regexp"
)

// Bild-zu-PDF-Eingabe: ein ZIP-Bündel, das der Browser aus den gewählten
// Bildern baut. Es darf nur ungepackte Einträge ("stored") enthalten, damit
// weder Zip-Bomben noch Entpackkosten entstehen, und die Einträge heißen
// lückenlos 001.ext, 002.ext, … in Seitenreihenfolge. Hier wird nur die
// Struktur geprüft und der Dateityp je Eintrag erkannt; Dekodierung,
// Abmessungen und Animation prüft der isolierte Konverter.

var (
	// ErrBundleInvalid: kein gültiges Bündel (Struktur, Namen, Prüfsumme).
	ErrBundleInvalid = errors.New("jobs: ungültiges Bildbündel")
	// ErrBundleLimit: zu viele Bilder oder Größenlimit überschritten.
	ErrBundleLimit = errors.New("jobs: Bildbündel überschreitet Grenzen")
	// ErrBundleImageType: ein Eintrag ist kein unterstütztes statisches Bildformat.
	ErrBundleImageType = errors.New("jobs: Bildformat im Bündel nicht unterstützt")
)

// BundleLimits sind die Grenzen eines Bündels.
type BundleLimits struct {
	MaxImages     int64
	MaxImageBytes int64
	MaxTotalBytes int64
}

var bundleEntryName = regexp.MustCompile(`^(\d{3})\.[a-z0-9]{2,5}$`)

// bundleFormats: Eingabeformate von Bild zu PDF (wie die Bildwerkzeuge, ohne ICO und AVIF).
var bundleFormats = map[string]bool{"jpeg": true, "png": true, "webp": true, "gif": true, "bmp": true}

// ValidateImageBundle prüft das Bündel und liefert die Bildanzahl.
func ValidateImageBundle(r io.ReaderAt, size int64, lim BundleLimits) (int, error) {
	archive, err := zip.NewReader(r, size)
	if err != nil {
		return 0, ErrBundleInvalid
	}
	count := int64(len(archive.File))
	if count == 0 {
		return 0, ErrBundleInvalid
	}
	if count > lim.MaxImages {
		return 0, ErrBundleLimit
	}
	var total int64
	for i, f := range archive.File {
		match := bundleEntryName.FindStringSubmatch(f.Name)
		if match == nil || match[1] != fmt.Sprintf("%03d", i+1) || f.FileInfo().IsDir() ||
			f.Flags&0x1 != 0 || f.Method != zip.Store ||
			f.UncompressedSize64 == 0 || f.UncompressedSize64 != f.CompressedSize64 {
			return 0, ErrBundleInvalid
		}
		if f.UncompressedSize64 > uint64(lim.MaxImageBytes) {
			return 0, ErrBundleLimit
		}
		total += int64(f.UncompressedSize64)
		if total > lim.MaxTotalBytes {
			return 0, ErrBundleLimit
		}
		if err := checkBundleEntry(f); err != nil {
			return 0, err
		}
	}
	return int(count), nil
}

// checkBundleEntry erkennt das Format am Anfang und liest den Eintrag
// vollständig, damit die CRC-Prüfsumme des ZIPs verifiziert wird.
func checkBundleEntry(f *zip.File) error {
	rc, err := f.Open()
	if err != nil {
		return ErrBundleInvalid
	}
	defer rc.Close()
	head := make([]byte, min(f.UncompressedSize64, SniffBytes))
	if _, err := io.ReadFull(rc, head); err != nil {
		return ErrBundleInvalid
	}
	format := DetectImageFormat(head)
	if _, err := io.Copy(io.Discard, rc); err != nil {
		return ErrBundleInvalid
	}
	if !bundleFormats[format] {
		return ErrBundleImageType
	}
	return nil
}
