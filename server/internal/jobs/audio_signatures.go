package jobs

import "bytes"

// Formaterkennung für audio-convert anhand der ersten Dateibytes. Sie
// entscheidet nur über die Annahme (415 unsupported-type); Dauer, Kanäle,
// Abtastrate und Kodierung prüft der Konverter (soundfile) im Worker.

// DetectAudioFormat liefert mp3, wav, flac, ogg oder "".
func DetectAudioFormat(head []byte) string {
	switch {
	case isWAV(head):
		return "wav"
	case isFLAC(head):
		return "flac"
	}
	return ""
}

// isWAV: RIFF-Container mit Formtyp WAVE (WebP/AVI teilen sich RIFF).
func isWAV(b []byte) bool {
	return len(b) >= 12 && bytes.Equal(b[:4], []byte("RIFF")) && bytes.Equal(b[8:12], []byte("WAVE"))
}

// isFLAC: "fLaC", danach muss der erste Metadatenblock STREAMINFO
// (Typ 0, 34 Bytes) sein, soweit der Kopf ihn enthält.
func isFLAC(b []byte) bool {
	if len(b) < 4 || !bytes.Equal(b[:4], []byte("fLaC")) {
		return false
	}
	if len(b) < 8 {
		return true
	}
	length := int(b[5])<<16 | int(b[6])<<8 | int(b[7])
	return b[4]&0x7f == 0 && length == 34
}
