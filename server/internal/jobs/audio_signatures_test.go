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
