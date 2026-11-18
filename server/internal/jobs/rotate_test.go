package jobs

import "testing"

func TestPDFRotateDownloadName(t *testing.T) {
	for in, want := range map[string]string{
		"Bericht.pdf":          "Bericht-gedreht.pdf",
		"../../etc/passwd.PDF": "_.._etc_passwd-gedreht.pdf",
		`a/b\c: d?.pdf`:        "a_b_c_ d_-gedreht.pdf",
		".pdf":                 "pdf-gedreht.pdf",
		"":                     "dokument-gedreht.pdf",
		"scan‮gnp.pdf":         "scangnp-gedreht.pdf",
		"zwei.teile.name.pdf":  "zwei.teile.name-gedreht.pdf",
	} {
		if got := PDFRotateDownloadName(in); got != want {
			t.Errorf("%q: got %q, want %q", in, got, want)
		}
	}
}

func TestRotateWorkingBytes(t *testing.T) {
	const ceiling = 300_000_000
	for _, tc := range []struct{ input, want int64 }{
		{0, rotateOverhead},
		{1000, 2000 + rotateOverhead},
		{100_000_000, 200_000_000 + rotateOverhead},
		{200_000_000, ceiling},
		{ceiling, ceiling},
	} {
		if got := RotateWorkingBytes(tc.input, ceiling); got != tc.want {
			t.Errorf("%d: got %d, want %d", tc.input, got, tc.want)
		}
	}
	if got := RotateWorkingBytes(5, 10); got != 10 {
		t.Errorf("ceiling must win, got %d", got)
	}
}
