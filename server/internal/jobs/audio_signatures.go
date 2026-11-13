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
	}
	return ""
}

// isWAV: RIFF-Container mit Formtyp WAVE (WebP/AVI teilen sich RIFF).
func isWAV(b []byte) bool {
	return len(b) >= 12 && bytes.Equal(b[:4], []byte("RIFF")) && bytes.Equal(b[8:12], []byte("WAVE"))
}
