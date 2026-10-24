package jobs_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"

	"miconverter/server/internal/jobs"
)

// python_golden.json erzeugt testdata/gen_golden.py aus dem Python-Backend.
type golden struct {
	Names []struct {
		Name         string            `json:"name"`
		DisplayImage string            `json:"displayImage"`
		DisplayPDF   string            `json:"displayPdf"`
		PDF          map[string]string `json:"pdf"`
		Image        []struct {
			Tool, Input, Output, Name string
		} `json:"image"`
	} `json:"names"`
	Options []struct {
		Input       string `json:"input"`
		Canonical   string `json:"canonical"`
		FileSHA256  string `json:"fileSha256"`
		FileSize    int64  `json:"fileSize"`
		Fingerprint string `json:"fingerprint"`
	} `json:"options"`
	Scalars []struct {
		Value     json.RawMessage `json:"value"`
		Canonical string          `json:"canonical"`
	} `json:"scalars"`
	Heads []struct {
		Head  string  `json:"head"`
		Image *string `json:"image"`
		PDF   bool    `json:"pdf"`
	} `json:"heads"`
}

func loadGolden(t *testing.T) golden {
	t.Helper()
	data, err := os.ReadFile("testdata/python_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var g golden
	if err := json.Unmarshal(data, &g); err != nil {
		t.Fatal(err)
	}
	return g
}

func TestNamingMatchesPython(t *testing.T) {
	g := loadGolden(t)
	if len(g.Names) < 50 {
		t.Fatalf("nur %d Fälle", len(g.Names))
	}
	for _, c := range g.Names {
		if got := jobs.DisplayName(c.Name, jobs.ImageFallbackBase); got != c.DisplayImage {
			t.Errorf("DisplayName(%q, bild) = %q, Python %q", c.Name, got, c.DisplayImage)
		}
		if got := jobs.DisplayName(c.Name, jobs.PDFFallbackBase); got != c.DisplayPDF {
			t.Errorf("DisplayName(%q, dokument) = %q, Python %q", c.Name, got, c.DisplayPDF)
		}
		for level, want := range c.PDF {
			if got := jobs.PDFDownloadName(c.Name, level); got != want {
				t.Errorf("PDFDownloadName(%q, %s) = %q, Python %q", c.Name, level, got, want)
			}
		}
		for _, img := range c.Image {
			if got := jobs.ImageDownloadName(c.Name, img.Tool, img.Input, img.Output); got != img.Name {
				t.Errorf("ImageDownloadName(%q, %s, %s→%s) = %q, Python %q",
					c.Name, img.Tool, img.Input, img.Output, got, img.Name)
			}
		}
	}
}

// pythonish wandelt einen per json.Unmarshal gelesenen Wert so um, wie
// Python ihn hielte: Zahlen mit Punkt/Exponent sind float, sonst int.
func pythonish(t *testing.T, raw json.RawMessage) any {
	t.Helper()
	var v any
	dec := json.NewDecoder(bytesReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&v); err != nil {
		t.Fatal(err)
	}
	return convertNumbers(t, v)
}

func convertNumbers(t *testing.T, v any) any {
	switch x := v.(type) {
	case json.Number:
		if i, err := x.Int64(); err == nil && !containsAny(string(x), ".eE") {
			return i
		}
		f, err := x.Float64()
		if err != nil {
			t.Fatal(err)
		}
		return f
	case []any:
		for i := range x {
			x[i] = convertNumbers(t, x[i])
		}
		return x
	case map[string]any:
		for k := range x {
			x[k] = convertNumbers(t, x[k])
		}
		return x
	}
	return v
}

func TestCanonicalJSONMatchesPython(t *testing.T) {
	g := loadGolden(t)
	for _, c := range g.Scalars {
		got, err := jobs.CanonicalJSON(pythonish(t, c.Value))
		if err != nil {
			t.Errorf("%s: %v", c.Value, err)
			continue
		}
		if string(got) != c.Canonical {
			t.Errorf("CanonicalJSON(%s) = %q, Python %q", c.Value, got, c.Canonical)
		}
	}
	for _, bad := range []any{nanValue(), "\xff", struct{}{}} {
		if _, err := jobs.CanonicalJSON(bad); err == nil {
			t.Errorf("CanonicalJSON(%v) ohne Fehler", bad)
		}
	}
}

func TestFingerprintMatchesPython(t *testing.T) {
	g := loadGolden(t)
	for _, c := range g.Options {
		// Python-kanonische Optionen erneut durch den Go-Kanonisierer
		// schicken: Ergebnis muss byte-gleich bleiben.
		again, err := jobs.CanonicalJSON(pythonish(t, json.RawMessage(c.Canonical)))
		if err != nil || string(again) != c.Canonical {
			t.Errorf("Kanonisierung %s → %s (%v)", c.Canonical, again, err)
		}
		var sha [32]byte
		raw, _ := hex.DecodeString(c.FileSHA256)
		copy(sha[:], raw)
		var tool struct{ Tool string }
		_ = json.Unmarshal([]byte(c.Canonical), &tool)
		fp, err := jobs.Fingerprint(tool.Tool, json.RawMessage(c.Canonical), sha, c.FileSize)
		if err != nil {
			t.Fatal(err)
		}
		if hex.EncodeToString(fp[:]) != c.Fingerprint {
			t.Errorf("Fingerprint(%s) weicht von Python ab", c.Input)
		}
	}
	if sha256.Size != 32 {
		t.Fatal("unerwartet")
	}
}

func TestSignaturesMatchPython(t *testing.T) {
	g := loadGolden(t)
	for _, c := range g.Heads {
		head, _ := hex.DecodeString(c.Head)
		want := ""
		if c.Image != nil {
			want = *c.Image
		}
		if got := jobs.DetectImageFormat(head); got != want {
			t.Errorf("DetectImageFormat(%s) = %q, Python %q", c.Head, got, want)
		}
		if got := jobs.IsPDF(head); got != c.PDF {
			t.Errorf("IsPDF(%s) = %v, Python %v", c.Head, got, c.PDF)
		}
	}
}
