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
	case isOGG(head):
		return "ogg"
	case isID3(head), isMPEGStream(head):
		return "mp3"
	}
	return ""
}

// isID3: ID3v2.2–2.4-Tag am Anfang (Version, Revision ≠ 0xff, Größe als
// syncsafe-Integer). Was nach dem Tag folgt, prüft der Konverter.
func isID3(b []byte) bool {
	if len(b) < 10 || !bytes.Equal(b[:3], []byte("ID3")) || b[3] < 2 || b[3] > 4 || b[4] == 0xff {
		return false
	}
	for _, c := range b[6:10] {
		if c >= 0x80 {
			return false
		}
	}
	return true
}

// Kbit/s je Bitratenindex 1–14 (0 = frei und 15 = ungültig werden abgelehnt).
var (
	mpegBitrateV1 = [3][15]int{
		{0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448}, // Layer I
		{0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384},    // Layer II
		{0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320},     // Layer III
	}
	mpegBitrateV2 = [3][15]int{
		{0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256}, // Layer I
		{0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160},      // Layer II
		{0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160},      // Layer III
	}
	// Abtastraten nach Versionsbits (0 = MPEG-2.5, 2 = MPEG-2, 3 = MPEG-1).
	mpegRates = map[byte][3]int{0: {11025, 12000, 8000}, 2: {22050, 24000, 16000}, 3: {44100, 48000, 32000}}
)

type mpegHeader struct {
	version, layer byte // Versions- bzw. Layerbits (Layer: 3 = I, 2 = II, 1 = III)
	length         int  // Framelänge in Bytes
}

// parseMPEGHeader prüft einen MPEG-Audio-Framekopf (11 Bit Sync).
func parseMPEGHeader(b []byte) (mpegHeader, bool) {
	if len(b) < 4 || b[0] != 0xff || b[1]&0xe0 != 0xe0 {
		return mpegHeader{}, false
	}
	version, layer := (b[1]>>3)&3, (b[1]>>1)&3
	bitrateIndex, rateIndex, padding := int(b[2]>>4), int((b[2]>>2)&3), int((b[2]>>1)&1)
	// Version 1 ist reserviert, Layer 0 ebenso (ADTS/AAC nutzt Layer 0).
	if version == 1 || layer == 0 || bitrateIndex == 0 || bitrateIndex == 15 || rateIndex == 3 {
		return mpegHeader{}, false
	}
	table := mpegBitrateV2
	if version == 3 {
		table = mpegBitrateV1
	}
	bitrate := table[3-layer][bitrateIndex] * 1000
	rate := mpegRates[version][rateIndex]
	var length int
	switch {
	case layer == 3: // Layer I: Slots zu 4 Bytes
		length = (12*bitrate/rate + padding) * 4
	case layer == 1 && version != 3: // Layer III bei MPEG-2/2.5
		length = 72*bitrate/rate + padding
	default:
		length = 144*bitrate/rate + padding
	}
	return mpegHeader{version: version, layer: layer, length: length}, true
}

// isMPEGStream: gültiger Framekopf am Dateianfang; liegt der Folgeframe noch
// im Kopf, muss er mit gleicher Version und gleichem Layer beginnen.
func isMPEGStream(b []byte) bool {
	first, ok := parseMPEGHeader(b)
	if !ok {
		return false
	}
	if first.length+4 > len(b) {
		return true
	}
	next, ok := parseMPEGHeader(b[first.length:])
	return ok && next.version == first.version && next.layer == first.layer
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

// isOGG: Seitenkopf "OggS", Strukturversion 0 und (falls enthalten) das
// Flag "beginning of stream" der ersten Seite.
func isOGG(b []byte) bool {
	if len(b) < 5 || !bytes.Equal(b[:4], []byte("OggS")) || b[4] != 0 {
		return false
	}
	return len(b) < 6 || b[5]&0x02 != 0
}
