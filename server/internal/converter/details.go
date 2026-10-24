package converter

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
)

// Struktur von details/analysis nach Vertrag §5. Der Parser darf keine
// beliebigen Daten in die API schleusen: Nur bekannte Felder mit geprüften
// Typen/Wertebereichen werden neu kodiert weitergereicht.

// MaxDetailsBytes begrenzt details/analysis vor der Prüfung.
const MaxDetailsBytes = 16 * 1024

var errDetails = errors.New("ungültige details/analysis")

var outputFormats = map[string]bool{"jpeg": true, "png": true, "webp": true, "bmp": true, "ico": true}

// ImageDetails: details eines Bildergebnisses.
type ImageDetails struct {
	Format                string `json:"format"`
	Width                 int64  `json:"width"`
	Height                int64  `json:"height"`
	SourceWidth           int64  `json:"sourceWidth"`
	SourceHeight          int64  `json:"sourceHeight"`
	Upscaled              bool   `json:"upscaled"`
	TransparencyFlattened bool   `json:"transparencyFlattened"`
	QualityApplied        bool   `json:"qualityApplied"`
}

// Note ist ein Hinweis mit Anzahl (PDF-Stufe).
type Note struct {
	Code  string `json:"code"`
	Count int64  `json:"count"`
}

// PdfDetails: details einer PDF-Stufe (wie PdfVariantResult ohne blob).
type PdfDetails struct {
	OriginalSize       int64  `json:"originalSize"`
	ImagesRecompressed int64  `json:"imagesRecompressed"`
	ImagesResized      int64  `json:"imagesResized"`
	ImagesSkipped      int64  `json:"imagesSkipped"`
	ImagesNotSmaller   int64  `json:"imagesNotSmaller"`
	StreamsCompressed  int64  `json:"streamsCompressed"`
	ObjectsRemoved     int64  `json:"objectsRemoved"`
	Notes              []Note `json:"notes"`
}

// Limitation ist ein Analysehinweis; Count bzw. Bytes nur bei passenden Codes.
type Limitation struct {
	Code  string `json:"code"`
	Count *int64 `json:"count,omitempty"`
	Bytes *int64 `json:"bytes,omitempty"`
}

// PdfImages: Bildstatistik der Analyse.
type PdfImages struct {
	Total               int64            `json:"total"`
	Recompressible      int64            `json:"recompressible"`
	Skipped             map[string]int64 `json:"skipped"`
	ByFilter            map[string]int64 `json:"byFilter"`
	Bytes               int64            `json:"bytes"`
	RecompressibleBytes int64            `json:"recompressibleBytes"`
	MaskCount           int64            `json:"maskCount"`
}

// PdfAnalysis wie PdfAnalysis in src/lib/pdf/types.ts.
type PdfAnalysis struct {
	FileSize    int64        `json:"fileSize"`
	PdfVersion  string       `json:"pdfVersion"`
	PageCount   int64        `json:"pageCount"`
	Encrypted   bool         `json:"encrypted"`
	Images      PdfImages    `json:"images"`
	FontBytes   int64        `json:"fontBytes"`
	Limitations []Limitation `json:"limitations"`
}

var (
	noteCodes   = map[string]bool{"images-skipped": true, "images-not-smaller": true, "image-size-unknown": true, "signatures-invalidated": true}
	skipReasons = map[string]bool{
		"invalid-dict": true, "image-mask": true, "filter": true, "cmyk": true, "colorspace": true,
		"bits-per-component": true, "decode-array": true, "mask": true, "too-many-pixels": true, "decode-parms": true,
	}
	countLimitations = map[string]bool{"images-not-recompressible": true, "image-size-unknown": true, "signatures-invalidated": true}
	pdfVersionRe     = regexp.MustCompile(`^[0-9]{1,2}\.[0-9]{1,2}$`)
)

func detailsErr(err error) error { return fmt.Errorf("%w: %w", errDetails, err) }

func counts(o object, keys ...string) ([]int64, error) {
	out := make([]int64, len(keys))
	for i, k := range keys {
		n, err := o.integer(k, 0, maxJSONInt)
		if err != nil {
			return nil, err
		}
		out[i] = n
	}
	return out, nil
}

// ValidateImageDetails prüft details eines Bildergebnisses gegen die Grenzen.
func ValidateImageDetails(raw []byte, limits Limits) (json.RawMessage, error) {
	if len(raw) > MaxDetailsBytes {
		return nil, detailsErr(errors.New("zu groß"))
	}
	o, err := parseObject(raw, []string{"format", "width", "height", "sourceWidth", "sourceHeight",
		"upscaled", "transparencyFlattened", "qualityApplied"}, nil)
	if err != nil {
		return nil, detailsErr(err)
	}
	var d ImageDetails
	if d.Format, err = o.str("format", 8); err != nil || !outputFormats[d.Format] {
		return nil, detailsErr(errors.New("format"))
	}
	dims := []*int64{&d.Width, &d.Height, &d.SourceWidth, &d.SourceHeight}
	for i, k := range []string{"width", "height", "sourceWidth", "sourceHeight"} {
		if *dims[i], err = o.integer(k, 1, limits.ImageMaxEdge); err != nil {
			return nil, detailsErr(err)
		}
	}
	flags := []*bool{&d.Upscaled, &d.TransparencyFlattened, &d.QualityApplied}
	for i, k := range []string{"upscaled", "transparencyFlattened", "qualityApplied"} {
		if *flags[i], err = o.boolean(k); err != nil {
			return nil, detailsErr(err)
		}
	}
	return json.Marshal(d)
}

func parseNotes(o object, key string, codes map[string]bool) ([]Note, error) {
	items, err := o.array(key, 8)
	if err != nil {
		return nil, err
	}
	notes := make([]Note, 0, len(items))
	for _, item := range items {
		n, err := parseObject(item, []string{"code", "count"}, nil)
		if err != nil {
			return nil, err
		}
		code, err := n.str("code", 40)
		if err != nil || !codes[code] {
			return nil, errors.New("note code")
		}
		count, err := n.integer("count", 1, maxJSONInt)
		if err != nil {
			return nil, err
		}
		notes = append(notes, Note{Code: code, Count: count})
	}
	return notes, nil
}

// ValidatePdfDetails prüft details einer PDF-Stufe.
func ValidatePdfDetails(raw []byte) (json.RawMessage, error) {
	if len(raw) > MaxDetailsBytes {
		return nil, detailsErr(errors.New("zu groß"))
	}
	keys := []string{"originalSize", "imagesRecompressed", "imagesResized", "imagesSkipped",
		"imagesNotSmaller", "streamsCompressed", "objectsRemoved"}
	o, err := parseObject(raw, append(keys, "notes"), nil)
	if err != nil {
		return nil, detailsErr(err)
	}
	n, err := counts(o, keys...)
	if err != nil {
		return nil, detailsErr(err)
	}
	notes, err := parseNotes(o, "notes", noteCodes)
	if err != nil {
		return nil, detailsErr(err)
	}
	return json.Marshal(PdfDetails{
		OriginalSize: n[0], ImagesRecompressed: n[1], ImagesResized: n[2], ImagesSkipped: n[3],
		ImagesNotSmaller: n[4], StreamsCompressed: n[5], ObjectsRemoved: n[6], Notes: notes,
	})
}

func countMap(o object, key string, allowed map[string]bool, required bool) (map[string]int64, error) {
	var keys []string
	for k := range allowed {
		keys = append(keys, k)
	}
	var m object
	var err error
	if required {
		m, err = o.nested(key, keys, nil)
	} else {
		m, err = o.nested(key, nil, keys)
	}
	if err != nil {
		return nil, err
	}
	out := make(map[string]int64, len(m))
	for k := range m {
		v, err := m.integer(k, 0, maxJSONInt)
		if err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, nil
}

// ValidatePdfAnalysis prüft das analysis-Ereignis.
func ValidatePdfAnalysis(raw []byte) (json.RawMessage, error) {
	if len(raw) > MaxDetailsBytes {
		return nil, detailsErr(errors.New("zu groß"))
	}
	o, err := parseObject(raw, []string{"fileSize", "pdfVersion", "pageCount", "encrypted", "images",
		"fontBytes", "limitations"}, nil)
	if err != nil {
		return nil, detailsErr(err)
	}
	var a PdfAnalysis
	n, err := counts(o, "fileSize", "pageCount", "fontBytes")
	if err != nil {
		return nil, detailsErr(err)
	}
	a.FileSize, a.PageCount, a.FontBytes = n[0], n[1], n[2]
	if a.PdfVersion, err = o.str("pdfVersion", 8); err != nil || !pdfVersionRe.MatchString(a.PdfVersion) {
		return nil, detailsErr(errors.New("pdfVersion"))
	}
	if a.Encrypted, err = o.boolean("encrypted"); err != nil || a.Encrypted {
		return nil, detailsErr(errors.New("encrypted"))
	}
	imgKeys := []string{"total", "recompressible", "bytes", "recompressibleBytes", "maskCount"}
	img, err := o.nested("images", append(imgKeys, "skipped", "byFilter"), nil)
	if err != nil {
		return nil, detailsErr(err)
	}
	in, err := counts(img, imgKeys...)
	if err != nil {
		return nil, detailsErr(err)
	}
	a.Images = PdfImages{Total: in[0], Recompressible: in[1], Bytes: in[2], RecompressibleBytes: in[3], MaskCount: in[4]}
	if a.Images.Skipped, err = countMap(img, "skipped", skipReasons, false); err != nil {
		return nil, detailsErr(err)
	}
	filters := map[string]bool{"dct": true, "flate": true, "none": true, "other": true}
	if a.Images.ByFilter, err = countMap(img, "byFilter", filters, true); err != nil {
		return nil, detailsErr(err)
	}
	items, err := o.array("limitations", 8)
	if err != nil {
		return nil, detailsErr(err)
	}
	a.Limitations = make([]Limitation, 0, len(items))
	for _, item := range items {
		head, err := parseObject(item, []string{"code"}, []string{"count", "bytes"})
		if err != nil {
			return nil, detailsErr(err)
		}
		code, err := head.str("code", 40)
		if err != nil {
			return nil, detailsErr(err)
		}
		l := Limitation{Code: code}
		switch {
		case code == "no-images":
			_, err = parseObject(item, []string{"code"}, nil)
		case countLimitations[code]:
			var c object
			if c, err = parseObject(item, []string{"code", "count"}, nil); err == nil {
				var v int64
				v, err = c.integer("count", 1, maxJSONInt)
				l.Count = &v
			}
		case code == "embedded-fonts-unchanged":
			var c object
			if c, err = parseObject(item, []string{"code", "bytes"}, nil); err == nil {
				var v int64
				v, err = c.integer("bytes", 1, maxJSONInt)
				l.Bytes = &v
			}
		default:
			err = errors.New("limitation code")
		}
		if err != nil {
			return nil, detailsErr(err)
		}
		a.Limitations = append(a.Limitations, l)
	}
	return json.Marshal(a)
}
