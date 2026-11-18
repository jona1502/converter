package jobs

import (
	"bytes"
	"errors"
	"io"
	"strings"
	"testing"
	"testing/iotest"
)

func TestBundleRoundTripPreservesOrderAndBytes(t *testing.T) {
	big := bytes.Repeat([]byte("x"), 3*bundleChunkSize+17)
	inputs := [][]byte{[]byte("%PDF-one"), big, []byte("%PDF-three")}
	var out bytes.Buffer
	w := NewBundleWriter(&out)
	for i, in := range inputs {
		size, head, err := w.AddFile(bytes.NewReader(in), int64(len(big)), 8)
		if err != nil || size != int64(len(in)) {
			t.Fatalf("Datei %d: %d %v", i, size, err)
		}
		if !bytes.Equal(head, in[:8]) {
			t.Fatalf("Kopf %d = %q", i, head)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if w.Written() != int64(out.Len()) {
		t.Fatalf("Written %d != %d", w.Written(), out.Len())
	}
	got, err := SplitBundle(out.Bytes())
	if err != nil || len(got) != 3 {
		t.Fatalf("%d Dateien, %v", len(got), err)
	}
	for i := range inputs {
		if !bytes.Equal(got[i], inputs[i]) {
			t.Fatalf("Datei %d verändert", i)
		}
	}
}

func TestBundleHandlesShortReads(t *testing.T) {
	data := []byte(strings.Repeat("%PDF-", 50000))
	var out bytes.Buffer
	w := NewBundleWriter(&out)
	if _, _, err := w.AddFile(iotest.OneByteReader(bytes.NewReader(data[:1000])), 1000, 5); err != nil {
		t.Fatal(err)
	}
	if _, _, err := w.AddFile(iotest.HalfReader(bytes.NewReader(data)), int64(len(data)), 5); err != nil {
		t.Fatal(err)
	}
	_ = w.Close()
	files, err := SplitBundle(out.Bytes())
	if err != nil || len(files) != 2 || !bytes.Equal(files[1], data) {
		t.Fatalf("%d %v", len(files), err)
	}
}

func TestBundleRejectsEmptyAndOversizedFiles(t *testing.T) {
	w := NewBundleWriter(io.Discard)
	if _, _, err := w.AddFile(bytes.NewReader(nil), 10, 4); !errors.Is(err, ErrBundleFile) {
		t.Fatalf("leer: %v", err)
	}
	if _, _, err := w.AddFile(bytes.NewReader(make([]byte, 11)), 10, 4); !errors.Is(err, ErrBundleFile) {
		t.Fatalf("zu groß: %v", err)
	}
	if _, _, err := w.AddFile(bytes.NewReader(make([]byte, 10)), 10, 4); err != nil {
		t.Fatalf("genau am Limit: %v", err)
	}
}

type countingReader struct{ n int }

func (c *countingReader) Read(p []byte) (int, error) {
	c.n += len(p)
	return len(p), nil
}

func TestBundleStopsReadingOversizedSource(t *testing.T) {
	src := &countingReader{}
	w := NewBundleWriter(io.Discard)
	if _, _, err := w.AddFile(src, 100, 4); !errors.Is(err, ErrBundleFile) {
		t.Fatal(err)
	}
	if src.n > 100+1+bundleChunkSize {
		t.Fatalf("zu viel gelesen: %d", src.n)
	}
}

func TestSplitBundleRejectsMalformed(t *testing.T) {
	var ok bytes.Buffer
	w := NewBundleWriter(&ok)
	_, _, _ = w.AddFile(strings.NewReader("%PDF-a"), 10, 4)
	_ = w.Close()
	cases := map[string][]byte{
		"ohne Kopf":      []byte("nope"),
		"abgeschnitten":  ok.Bytes()[:ok.Len()-2],
		"Rest nach Ende": append(append([]byte{}, ok.Bytes()...), 'x'),
		"Block zu lang":  append([]byte(BundleMagic), 0, 0, 0, 9, 'a'),
		"Kopf ohne Ende": []byte(BundleMagic),
	}
	for name, data := range cases {
		if _, err := SplitBundle(data); err == nil {
			t.Errorf("%s: akzeptiert", name)
		}
	}
}

func TestBundleWithoutFilesIsEmptyList(t *testing.T) {
	var out bytes.Buffer
	w := NewBundleWriter(&out)
	_ = w.Close()
	files, err := SplitBundle(out.Bytes())
	if err != nil || len(files) != 0 {
		t.Fatalf("%d %v", len(files), err)
	}
}

// Muss byte-gleich zu GOLDEN in converter/tests/test_pdf_merge.py sein.
func TestBundleMatchesGolden(t *testing.T) {
	var out bytes.Buffer
	w := NewBundleWriter(&out)
	for _, f := range []string{"%PDF-a", "%PDF-bb"} {
		if _, _, err := w.AddFile(strings.NewReader(f), 10, 4); err != nil {
			t.Fatal(err)
		}
	}
	_ = w.Close()
	want := "MIPDFMRG1\n" +
		"\x00\x00\x00\x06%PDF-a\x00\x00\x00\x00" +
		"\x00\x00\x00\x07%PDF-bb\x00\x00\x00\x00" +
		"\x00\x00\x00\x00"
	if out.String() != want {
		t.Fatalf("Bündel = %q", out.String())
	}
}
