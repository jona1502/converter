package jobs

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"testing"
)

var (
	bundleJPEG = append([]byte{0xff, 0xd8, 0xff, 0xe0}, bytes.Repeat([]byte{1}, 40)...)
	bundlePNG  = append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{2}, 40)...)
	bundleGIF  = append([]byte("GIF89a"), bytes.Repeat([]byte{3}, 40)...)
	bundleWebP = append([]byte("RIFF\x10\x00\x00\x00WEBPVP8 "), bytes.Repeat([]byte{4}, 40)...)
)

func bundleBMP() []byte {
	b := make([]byte, 54)
	b[0], b[1], b[14] = 'B', 'M', 40
	return b
}

type bundleEntry struct {
	name   string
	data   []byte
	method uint16
	flags  uint16
}

func makeBundle(t *testing.T, entries ...bundleEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for _, e := range entries {
		h := &zip.FileHeader{Name: e.name, Method: e.method, Flags: e.flags}
		part, err := w.CreateHeader(h)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(e.data); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func stored(name string, data []byte) bundleEntry {
	return bundleEntry{name: name, data: data, method: zip.Store}
}

var testBundleLimits = BundleLimits{MaxImages: 3, MaxImageBytes: 1000, MaxTotalBytes: 2000}

func validate(t *testing.T, raw []byte, lim BundleLimits) (int, error) {
	t.Helper()
	return ValidateImageBundle(bytes.NewReader(raw), int64(len(raw)), lim)
}

func TestValidateImageBundleAcceptsSupportedFormats(t *testing.T) {
	raw := makeBundle(t, stored("001.jpg", bundleJPEG), stored("002.png", bundlePNG), stored("003.webp", bundleWebP))
	n, err := validate(t, raw, testBundleLimits)
	if err != nil || n != 3 {
		t.Fatalf("n=%d err=%v", n, err)
	}
	raw = makeBundle(t, stored("001.gif", bundleGIF), stored("002.bmp", bundleBMP()))
	if n, err = validate(t, raw, testBundleLimits); err != nil || n != 2 {
		t.Fatalf("n=%d err=%v", n, err)
	}
}

func TestValidateImageBundleRejectsInvalidStructure(t *testing.T) {
	deflated := bundleEntry{name: "001.png", data: bundlePNG, method: zip.Deflate}
	cases := map[string][]byte{
		"kein ZIP":              []byte("das ist kein zip"),
		"leer":                  makeBundle(t),
		"komprimiert":           makeBundle(t, deflated),
		"verschlüsselt":         makeBundle(t, bundleEntry{name: "001.png", data: bundlePNG, method: zip.Store, flags: 0x1}),
		"falscher Name":         makeBundle(t, stored("bild.png", bundlePNG)),
		"Pfad":                  makeBundle(t, stored("../001.png", bundlePNG)),
		"Verzeichnis":           makeBundle(t, stored("001/", nil)),
		"Lücke in Nummerierung": makeBundle(t, stored("001.png", bundlePNG), stored("003.png", bundlePNG)),
		"falsche Reihenfolge":   makeBundle(t, stored("002.png", bundlePNG), stored("001.png", bundlePNG)),
		"doppelt":               makeBundle(t, stored("001.png", bundlePNG), stored("001.png", bundlePNG)),
		"leerer Eintrag":        makeBundle(t, stored("001.png", nil)),
	}
	for name, raw := range cases {
		if _, err := validate(t, raw, testBundleLimits); !errors.Is(err, ErrBundleInvalid) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestValidateImageBundleRejectsUnsupportedImages(t *testing.T) {
	for name, data := range map[string][]byte{
		"PDF":  []byte("%PDF-1.7 " + string(bytes.Repeat([]byte{'x'}, 40))),
		"Text": bytes.Repeat([]byte("hallo "), 10),
		"ICO":  append([]byte{0, 0, 1, 0, 1, 0}, bytes.Repeat([]byte{0}, 40)...),
	} {
		raw := makeBundle(t, stored("001.png", bundlePNG), stored("002.png", data))
		if _, err := validate(t, raw, testBundleLimits); !errors.Is(err, ErrBundleImageType) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestValidateImageBundleEnforcesLimits(t *testing.T) {
	var four []bundleEntry
	for i := 1; i <= 4; i++ {
		four = append(four, stored(fmt.Sprintf("%03d.png", i), bundlePNG))
	}
	if _, err := validate(t, makeBundle(t, four...), testBundleLimits); !errors.Is(err, ErrBundleLimit) {
		t.Errorf("zu viele Bilder: %v", err)
	}
	big := append(append([]byte{}, bundlePNG...), bytes.Repeat([]byte{9}, 1001)...)
	if _, err := validate(t, makeBundle(t, stored("001.png", big)), testBundleLimits); !errors.Is(err, ErrBundleLimit) {
		t.Errorf("zu großes Bild: %v", err)
	}
	mid := append(append([]byte{}, bundlePNG...), bytes.Repeat([]byte{9}, 800)...)
	raw := makeBundle(t, stored("001.png", mid), stored("002.png", mid), stored("003.png", mid))
	if _, err := validate(t, raw, testBundleLimits); !errors.Is(err, ErrBundleLimit) {
		t.Errorf("Gesamtgröße: %v", err)
	}
}

func TestValidateImageBundleDetectsCorruptEntry(t *testing.T) {
	raw := makeBundle(t, stored("001.png", bundlePNG))
	// Nutzdaten verändern, ohne die CRC-Prüfsumme anzupassen.
	i := bytes.Index(raw, bundlePNG)
	raw[i+20] ^= 0xff
	if _, err := validate(t, raw, testBundleLimits); !errors.Is(err, ErrBundleInvalid) {
		t.Errorf("CRC-Fehler nicht erkannt: %v", err)
	}
}
