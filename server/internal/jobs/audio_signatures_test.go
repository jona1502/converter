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
