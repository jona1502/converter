package jobs_test

import (
	"bytes"
	"testing"

	"miconverter/server/internal/jobs"
)

type sniffCase struct {
	name string
	head []byte
	want string
}

func cat(parts ...[]byte) []byte { return bytes.Join(parts, nil) }

func checkSniff(t *testing.T, cases []sniffCase) {
	t.Helper()
	for _, c := range cases {
		if got := jobs.DetectAudioFormat(c.head); got != c.want {
			t.Errorf("%s: DetectAudioFormat = %q, erwartet %q", c.name, got, c.want)
		}
	}
}

func TestDetectAudioFormatWAV(t *testing.T) {
	checkSniff(t, []sniffCase{
		{"wav", cat([]byte("RIFF\x24\x00\x00\x00WAVEfmt "), make([]byte, 20)), "wav"},
		{"webp ist kein wav", []byte("RIFF\x24\x00\x00\x00WEBPVP8 "), ""},
		{"avi ist kein wav", []byte("RIFF\x24\x00\x00\x00AVI LIST"), ""},
		{"zu kurz", []byte("RIFF\x24\x00\x00\x00WAV"), ""},
		{"leer", nil, ""},
		{"rf64 nicht unterstützt", []byte("RF64\xff\xff\xff\xffWAVEds64"), ""},
	})
}

func TestDetectAudioFormatFLAC(t *testing.T) {
	checkSniff(t, []sniffCase{
		{"flac letzter Block", cat([]byte("fLaC\x80\x00\x00\x22"), make([]byte, 34)), "flac"},
		{"flac weitere Blöcke", cat([]byte("fLaC\x00\x00\x00\x22"), make([]byte, 34)), "flac"},
		{"nur Magie", []byte("fLaC"), "flac"},
		{"falscher erster Block", cat([]byte("fLaC\x04\x00\x00\x22"), make([]byte, 34)), ""},
		{"falsche STREAMINFO-Länge", cat([]byte("fLaC\x00\x00\x00\x10"), make([]byte, 16)), ""},
		{"kleingeschrieben", []byte("flac\x00\x00\x00\x22"), ""},
	})
}

func TestDetectAudioFormatOGG(t *testing.T) {
	checkSniff(t, []sniffCase{
		{"ogg erste Seite", cat([]byte("OggS\x00\x02"), make([]byte, 22)), "ogg"},
		{"nur Magie und Version", []byte("OggS\x00"), "ogg"},
		{"Version 1", cat([]byte("OggS\x01\x02"), make([]byte, 22)), ""},
		{"keine Anfangsseite", cat([]byte("OggS\x00\x00"), make([]byte, 22)), ""},
		{"nur Magie", []byte("OggS"), ""},
	})
}

// mpegFrame liefert einen Frame mit Kopf h und der zur Kopfangabe passenden Länge.
func mpegFrame(h []byte, length int) []byte { return cat(h, make([]byte, length-len(h))) }

func TestDetectAudioFormatMP3(t *testing.T) {
	v1l3 := []byte{0xff, 0xfb, 0x90, 0x00}    // MPEG-1 Layer III, 128 kbit/s, 44,1 kHz: 417 Bytes
	v1l3pad := []byte{0xff, 0xfb, 0x92, 0x00} // dasselbe mit Padding: 418 Bytes
	v2l3 := []byte{0xff, 0xf3, 0x80, 0x00}    // MPEG-2 Layer III, 64 kbit/s, 22,05 kHz: 208 Bytes
	v1l2 := []byte{0xff, 0xfd, 0x90, 0x00}    // MPEG-1 Layer II, 128 kbit/s, 44,1 kHz: 417 Bytes
	checkSniff(t, []sniffCase{
		{"id3v2.4", cat([]byte("ID3\x04\x00\x00\x00\x00\x02\x01"), make([]byte, 64)), "mp3"},
		{"id3v2.3", []byte("ID3\x03\x00\x80\x00\x00\x00\x0a"), "mp3"},
		{"id3 unbekannte Version", []byte("ID3\x05\x00\x00\x00\x00\x00\x0a"), ""},
		{"id3 Revision ff", []byte("ID3\x03\xff\x00\x00\x00\x00\x0a"), ""},
		{"id3 Größe nicht syncsafe", []byte("ID3\x04\x00\x00\x00\x80\x00\x0a"), ""},
		{"zwei Frames", cat(mpegFrame(v1l3, 417), v1l3), "mp3"},
		{"Frame mit Padding", cat(mpegFrame(v1l3pad, 418), v1l3), "mp3"},
		{"MPEG-2", cat(mpegFrame(v2l3, 208), v2l3), "mp3"},
		{"Layer II", cat(mpegFrame(v1l2, 417), v1l2), "mp3"},
		{"ein Kopf, Rest außerhalb", cat(v1l3, make([]byte, 100)), "mp3"},
		{"zweiter Kopf fehlt", cat(mpegFrame(v1l3, 417), []byte{0, 0, 0, 0}), ""},
		{"zweiter Kopf anderes Layer", cat(mpegFrame(v1l3, 417), v1l2), ""},
		{"AAC ADTS", []byte{0xff, 0xf1, 0x50, 0x80, 0x00, 0x1f, 0xfc}, ""},
		{"freie Bitrate", []byte{0xff, 0xfb, 0x00, 0x00}, ""},
		{"Bitrate 15", []byte{0xff, 0xfb, 0xf0, 0x00}, ""},
		{"Abtastrate 3", []byte{0xff, 0xfb, 0x9c, 0x00}, ""},
		{"Version reserviert", []byte{0xff, 0xeb, 0x90, 0x00}, ""},
		{"JPEG", []byte{0xff, 0xd8, 0xff, 0xe0}, ""},
		{"Sync erst später", cat([]byte{0x00}, v1l3), ""},
		{"zu kurz", []byte{0xff, 0xfb, 0x90}, ""},
	})
}

func TestDetectAudioFormatKeepsOtherTypesApart(t *testing.T) {
	for name, head := range map[string][]byte{
		"pdf":  []byte("%PDF-1.7\n"),
		"png":  []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR"),
		"webp": []byte("RIFF\x24\x00\x00\x00WEBPVP8 "),
		"text": []byte("hello world, this is not audio"),
	} {
		if got := jobs.DetectAudioFormat(head); got != "" {
			t.Errorf("%s als %q erkannt", name, got)
		}
	}
	for _, head := range [][]byte{[]byte("RIFF\x24\x00\x00\x00WAVEfmt "), []byte("fLaC"), []byte("OggS\x00\x02"), []byte("ID3\x04\x00\x00\x00\x00\x00\x0a")} {
		if got := jobs.DetectImageFormat(head); got != "" {
			t.Errorf("Audio %q als Bild %q erkannt", head[:4], got)
		}
	}
}
