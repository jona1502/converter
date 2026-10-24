package jobs

import (
	"bytes"
	"encoding/binary"
)

// Formaterkennung anhand der ersten Dateibytes, Portierung von
// app/jobs/signatures.py (gleiche Regeln wie src/lib/image/sniff.ts).

const (
	// SniffBytes: so viele Anfangsbytes hält der Upload für die Erkennung.
	SniffBytes         = 4096
	pdfSignatureWindow = 1024
)

var pngSignature = []byte("\x89PNG\r\n\x1a\n")

func isBMP(b []byte) bool {
	// "BM" allein ist zu schwach; zusätzlich muss die DIB-Headergröße bekannt sein.
	if len(b) < 18 || b[0] != 'B' || b[1] != 'M' {
		return false
	}
	switch binary.LittleEndian.Uint32(b[14:]) {
	case 12, 40, 52, 56, 64, 108, 124:
		return true
	}
	return false
}

func isICO(b []byte) bool {
	// reserved 0, type 1 (Cursor = 2 nicht unterstützt), mindestens ein Eintrag.
	if len(b) < 6 || binary.LittleEndian.Uint16(b[0:]) != 0 || binary.LittleEndian.Uint16(b[2:]) != 1 {
		return false
	}
	count := uint32(binary.LittleEndian.Uint16(b[4:]))
	if count < 1 {
		return false
	}
	if len(b) >= 6+16 {
		size := binary.LittleEndian.Uint32(b[6+8:])
		offset := binary.LittleEndian.Uint32(b[6+12:])
		if size == 0 || uint64(offset) < 6+16*uint64(count) {
			return false
		}
	}
	return true
}

func isAVIF(b []byte) bool {
	if len(b) < 16 || !bytes.Equal(b[4:8], []byte("ftyp")) {
		return false
	}
	size := binary.BigEndian.Uint32(b[0:])
	if size < 16 || size > 4096 {
		return false
	}
	end := min(int(size), len(b))
	brand := func(o int) bool {
		x := b[o : o+4]
		return bytes.Equal(x, []byte("avif")) || bytes.Equal(x, []byte("avis"))
	}
	if brand(8) {
		return true
	}
	for o := 16; o < end-3; o += 4 {
		if brand(o) {
			return true
		}
	}
	return false
}

// DetectImageFormat liefert jpeg, png, webp, gif, bmp, avif, ico oder "".
func DetectImageFormat(head []byte) string {
	switch {
	case bytes.HasPrefix(head, []byte{0xff, 0xd8, 0xff}):
		return "jpeg"
	case bytes.HasPrefix(head, pngSignature):
		return "png"
	case len(head) >= 12 && bytes.Equal(head[:4], []byte("RIFF")) && bytes.Equal(head[8:12], []byte("WEBP")):
		return "webp"
	case bytes.HasPrefix(head, []byte("GIF87a")) || bytes.HasPrefix(head, []byte("GIF89a")):
		return "gif"
	case isBMP(head):
		return "bmp"
	case isAVIF(head):
		return "avif"
	case isICO(head):
		return "ico"
	}
	return ""
}

// IsPDF: "%PDF-" innerhalb der ersten 1024 Bytes.
func IsPDF(head []byte) bool {
	return bytes.Contains(head[:min(len(head), pdfSignatureWindow)], []byte("%PDF-"))
}
