package validation_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"miconverter/server/internal/apitypes"
	"miconverter/server/internal/validation"
)

type inner struct {
	Count int                         `json:"count"`
	Note  validation.Optional[string] `json:"note,omitzero"`
}

type sample struct {
	Name    string                         `json:"name"`
	Quality validation.Optional[float64]   `json:"quality,omitzero" strict:"notnull"`
	Width   validation.Optional[int]       `json:"width,omitzero"`
	Enabled bool                           `json:"enabled"`
	Inner   inner                          `json:"inner"`
	List    []int                          `json:"list,omitempty"`
	Ptr     *int                           `json:"ptr"`
	Tags    map[string]int                 `json:"tags,omitempty"`
	Small   validation.Optional[int8]      `json:"small,omitzero"`
	Levels  validation.Optional[[]string]  `json:"levels,omitzero" strict:"notnull"`
	Free    json.RawMessage                `json:"free,omitempty"`
	Any     any                            `json:"any,omitempty"`
	F32     validation.Optional[float32]   `json:"f32,omitzero"`
	U       validation.Optional[uint16]    `json:"u,omitzero"`
	Deep    validation.Optional[[][][]int] `json:"deep,omitzero"`
}

var lim = validation.Limits{MaxBytes: 4096, MaxDepth: 4}

const valid = `{"name":"a","enabled":false,"inner":{"count":0}}`

func decode(t *testing.T, in string) (sample, *validation.DecodeError) {
	t.Helper()
	var s sample
	err := validation.DecodeStrict(strings.NewReader(in), lim, "options", &s)
	if err == nil {
		return s, nil
	}
	var de *validation.DecodeError
	if !errors.As(err, &de) {
		t.Fatalf("erwartet DecodeError, erhalten %T %v", err, err)
	}
	return s, de
}

func fieldsOf(de *validation.DecodeError) string {
	parts := make([]string, len(de.Fields))
	for i, f := range de.Fields {
		parts[i] = f.Path + "=" + f.Code
	}
	return strings.Join(parts, " ")
}

func TestValidInputKeepsZeroValuesDistinctFromMissing(t *testing.T) {
	s, de := decode(t, `{"name":"","enabled":false,"inner":{"count":0},"quality":0,"width":null,"ptr":null}`)
	if de != nil {
		t.Fatalf("unerwarteter Fehler: %s", fieldsOf(de))
	}
	q, ok := s.Quality.Value()
	if !ok || q != 0 || !s.Quality.Set() || s.Quality.Null() {
		t.Fatalf("quality 0 muss als gesetzter Wert erhalten bleiben: %+v", s.Quality)
	}
	if s.Quality.Or(0.85) != 0 {
		t.Fatal("Or darf einen gesetzten Wert 0 nicht ersetzen")
	}
	if !s.Width.Set() || !s.Width.Null() {
		t.Fatal("width null muss als null erkannt werden")
	}
	if s.Small.Set() || s.Note().Set() {
		t.Fatal("fehlende Felder dürfen nicht gesetzt sein")
	}
	if s.Small.Or(7) != 7 {
		t.Fatal("Or liefert den Standard für fehlende Felder")
	}
}

func (s sample) Note() validation.Optional[string] { return s.Inner.Note }

func TestRejections(t *testing.T) {
	cases := []struct {
		name, in string
		kind     validation.Kind
		want     string
	}{
		{"unbekanntes Feld", `{"name":"a","enabled":true,"inner":{"count":1},"geheim-name":1}`, validation.KindInvalid, "options=unknown-field"},
		{"unbekanntes Feld verschachtelt", `{"name":"a","enabled":true,"inner":{"count":1,"x":2}}`, validation.KindInvalid, "options.inner=unknown-field"},
		{"Groß-/Kleinschreibung", `{"Name":"a","enabled":true,"inner":{"count":1}}`, validation.KindInvalid, "options=unknown-field options.name=missing"},
		{"Duplikat", `{"name":"a","name":"b","enabled":true,"inner":{"count":1}}`, validation.KindInvalid, "options.name=duplicate-key"},
		{"falscher Typ", `{"name":1,"enabled":"true","inner":{"count":"1"}}`, validation.KindInvalid, "options.name=invalid-type options.enabled=invalid-type options.inner.count=invalid-type"},
		{"null bei Pflichtfeld", `{"name":null,"enabled":true,"inner":{"count":1}}`, validation.KindInvalid, "options.name=invalid-type"},
		{"null bei notnull", `{"name":"a","enabled":true,"inner":{"count":1},"quality":null}`, validation.KindInvalid, "options.quality=invalid-type"},
		{"null bei Liste notnull", `{"name":"a","enabled":true,"inner":{"count":1},"levels":null}`, validation.KindInvalid, "options.levels=invalid-type"},
		{"fehlende Felder", `{}`, validation.KindInvalid, "options.name=missing options.enabled=missing options.inner=missing"},
		{"Ganzzahl mit Nachkomma", `{"name":"a","enabled":true,"inner":{"count":1.5}}`, validation.KindInvalid, "options.inner.count=invalid-type"},
		{"Ganzzahl als Exponent", `{"name":"a","enabled":true,"inner":{"count":1e2}}`, validation.KindInvalid, "options.inner.count=invalid-type"},
		{"Ganzzahl zu groß", `{"name":"a","enabled":true,"inner":{"count":1},"small":128}`, validation.KindInvalid, "options.small=out-of-range"},
		{"negativ für uint", `{"name":"a","enabled":true,"inner":{"count":1},"u":-1}`, validation.KindInvalid, "options.u=out-of-range"},
		{"Float-Überlauf", `{"name":"a","enabled":true,"inner":{"count":1},"quality":1e400}`, validation.KindInvalid, "options.quality=out-of-range"},
		{"float32-Überlauf", `{"name":"a","enabled":true,"inner":{"count":1},"f32":1e39}`, validation.KindInvalid, "options.f32=out-of-range"},
		{"Liste mit Index", `{"name":"a","enabled":true,"inner":{"count":1},"levels":["x",2]}`, validation.KindInvalid, "options.levels.1=invalid-type"},
		{"Objekt statt Zahl", `{"name":"a","enabled":true,"inner":{"count":{"a":[1]}}}`, validation.KindInvalid, "options.inner.count=invalid-type"},
		{"Top-Level Liste", `[1]`, validation.KindInvalid, "options=invalid-type"},
		{"nachfolgender Wert", valid + ` {}`, validation.KindInvalidJSON, "options=trailing-data"},
		{"nachfolgender Müll", valid + ` x`, validation.KindInvalidJSON, "options=invalid-json"},
		{"Syntaxfehler", `{"name": `, validation.KindInvalidJSON, "options=invalid-json"},
		{"leer", ``, validation.KindInvalidJSON, "options=invalid-json"},
		{"ungültiges UTF-8", "{\"name\":\"\xff\",\"enabled\":true,\"inner\":{\"count\":1}}", validation.KindInvalidJSON, "options=invalid-json"},
		{"zu tief", `{"name":"a","enabled":true,"inner":{"count":1},"deep":[[[[1]]]]}`, validation.KindTooDeep, "options=too-deep"},
		{"zu tief in freiem Wert", `{"name":"a","enabled":true,"inner":{"count":1},"any":{"a":{"b":{"c":{}}}}}`, validation.KindTooDeep, "options=too-deep"},
		{"zu tief in unbekanntem Feld", `{"x":[[[[[]]]]]}`, validation.KindTooDeep, "options=too-deep"},
		{"Map-Duplikat", `{"name":"a","enabled":true,"inner":{"count":1},"tags":{"k":1,"k":2}}`, validation.KindInvalid, "options.tags.k=duplicate-key"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, de := decode(t, tc.in)
			if de == nil {
				t.Fatal("erwartet Fehler")
			}
			if de.Kind != tc.kind || fieldsOf(de) != tc.want {
				t.Fatalf("erhalten %s [%s], erwartet %s [%s]", de.Kind, fieldsOf(de), tc.kind, tc.want)
			}
		})
	}
}

func TestDepthLimitAllowsExactDepth(t *testing.T) {
	// Objekt (1) → deep (2) → (3) → (4): genau MaxDepth.
	if _, de := decode(t, `{"name":"a","enabled":true,"inner":{"count":1},"deep":[[[1]]]}`); de != nil {
		t.Fatalf("unerwarteter Fehler: %s", fieldsOf(de))
	}
}

func TestSizeLimit(t *testing.T) {
	var s sample
	big := `{"name":"` + strings.Repeat("a", 5000) + `","enabled":true,"inner":{"count":1}}`
	err := validation.DecodeStrict(strings.NewReader(big), lim, "", &s)
	var de *validation.DecodeError
	if !errors.As(err, &de) || de.Kind != validation.KindTooLarge || fieldsOf(de) != "body=too-large" {
		t.Fatalf("erwartet too-large, erhalten %v", err)
	}
	// Genau am Limit ist erlaubt.
	exact := `{"name":"` + strings.Repeat("a", 4096-len(`{"name":"","enabled":false,"inner":{"count":0}}`)) + `","enabled":false,"inner":{"count":0}}`
	if len(exact) != 4096 {
		t.Fatalf("Testdaten falsch: %d", len(exact))
	}
	if err := validation.DecodeStrict(strings.NewReader(exact), lim, "", &s); err != nil {
		t.Fatalf("Eingabe genau am Limit: %v", err)
	}
}

func TestErrorsNeverContainInputValues(t *testing.T) {
	in := `{"name":"geheim-wert","enabled":"geheim-bool","inner":{"count":"geheim-zahl","geheim-key":1},"quality":"geheim-q"}`
	_, de := decode(t, in)
	if de == nil {
		t.Fatal("erwartet Fehler")
	}
	out := de.Error() + fmt.Sprintf("%+v", de)
	if strings.Contains(out, "geheim") {
		t.Fatalf("Fehler enthält Eingabewerte: %s", out)
	}
}

func TestFieldErrorsAreLimited(t *testing.T) {
	var b strings.Builder
	b.WriteString(`{"tags":{`)
	for i := range 50 {
		if i > 0 {
			b.WriteByte(',')
		}
		fmt.Fprintf(&b, `"%d-%s":"x"`, i, strings.Repeat("k", 100))
	}
	b.WriteString(`}}`)
	var s sample
	err := validation.DecodeStrict(strings.NewReader(b.String()), validation.Limits{MaxBytes: 1 << 20}, "", &s)
	var de *validation.DecodeError
	if !errors.As(err, &de) {
		t.Fatalf("erwartet DecodeError: %v", err)
	}
	if len(de.Fields) != validation.MaxFieldErrors {
		t.Fatalf("erwartet %d Fehler, erhalten %d", validation.MaxFieldErrors, len(de.Fields))
	}
	for _, f := range de.Fields {
		if len([]rune(f.Path)) > validation.MaxFieldPathLength {
			t.Fatalf("Pfad zu lang: %d", len(f.Path))
		}
	}
}

func TestDstMustBePointer(t *testing.T) {
	if err := validation.DecodeStrictBytes([]byte(`{}`), lim, "", sample{}); err == nil {
		t.Fatal("erwartet Fehler für Nicht-Zeiger")
	}
}

// --- Auftragsoptionen (apitypes) -------------------------------------------

func decodeOptions(t *testing.T, in string) (apitypes.JobOptions, *validation.DecodeError) {
	t.Helper()
	var o apitypes.JobOptions
	err := validation.DecodeStrictBytes([]byte(in), validation.Limits{MaxBytes: 8 << 10, MaxDepth: 8}, "options", &o)
	if err == nil {
		return o, nil
	}
	var de *validation.DecodeError
	if !errors.As(err, &de) {
		t.Fatalf("erwartet DecodeError, erhalten %v", err)
	}
	return o, de
}

func TestJobOptionsImage(t *testing.T) {
	o, de := decodeOptions(t, `{"tool":"image-convert","format":"webp","quality":0,"resize":{"mode":"dimensions","width":100,"height":null,"keepAspectRatio":true,"allowUpscale":false},"icoSizes":null}`)
	if de != nil {
		t.Fatalf("unerwarteter Fehler: %s", fieldsOf(de))
	}
	img, ok := o.Image()
	if !ok {
		t.Fatalf("erwartet ImageOptions, erhalten %T", o.Value)
	}
	if q, ok := img.Quality.Value(); !ok || q != 0 {
		t.Fatal("quality 0 verloren")
	}
	if img.Background.Set() || !img.IcoSizes.Null() {
		t.Fatal("fehlend/null falsch erkannt")
	}
	resize, _ := img.Resize.Value()
	dims, ok := resize.Value.(*apitypes.ResizeDimensions)
	if !ok || resize.Mode() != apitypes.ResizeModeDimensions {
		t.Fatalf("erwartet ResizeDimensions, erhalten %T", resize.Value)
	}
	if w, _ := dims.Width.Value(); w != 100 || !dims.Height.Null() || !dims.KeepAspectRatio {
		t.Fatalf("Resize-Werte falsch: %+v", dims)
	}
	// Rundreise: fehlende Felder bleiben fehlend, null bleibt null.
	out, err := json.Marshal(o)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"tool":"image-convert","format":"webp","quality":0,"resize":{"mode":"dimensions","width":100,"height":null,"keepAspectRatio":true,"allowUpscale":false},"icoSizes":null}`
	if string(out) != want {
		t.Fatalf("Rundreise:\n%s\n%s", out, want)
	}
}

func TestJobOptionsPdfDefaults(t *testing.T) {
	o, de := decodeOptions(t, `{"tool":"pdf-compress"}`)
	if de != nil {
		t.Fatalf("unerwarteter Fehler: %s", fieldsOf(de))
	}
	pdf, ok := o.Pdf()
	if !ok || pdf.Levels.Set() {
		t.Fatalf("levels muss fehlen: %+v", o.Value)
	}
}

func TestJobOptionsRejections(t *testing.T) {
	cases := []struct{ in, want string }{
		{`{"format":"webp"}`, "options=union-tag-not-found"},
		{`{"tool":"video","format":"webp"}`, "options=union-tag-invalid"},
		{`{"tool":1}`, "options=union-tag-invalid"},
		{`{"tool":"pdf-compress","format":"webp"}`, "options=unknown-field"},
		{`{"tool":"pdf-compress","levels":null}`, "options.levels=invalid-type"},
		{`{"tool":"image-resize","format":"png","resize":{"mode":"percent","percent":50}}`, "options.resize.allowUpscale=missing"},
		{`{"tool":"image-resize","format":"png","resize":{"mode":"none","width":5}}`, "options.resize=unknown-field"},
		{`{"tool":"image-resize","format":"png","resize":{"mode":"zoom"}}`, "options.resize=union-tag-invalid"},
		{`{"tool":"image-resize","format":"png","resize":null}`, "options.resize=invalid-type"},
		{`{"tool":"image-resize","format":"png","resize":"none"}`, "options.resize=invalid-type"},
		{`{"tool":"image-convert","format":"png","quality":"0.5"}`, "options.quality=invalid-type"},
		{`{"tool":"image-convert","format":"png","icoSizes":[16,"32"]}`, "options.icoSizes.1=invalid-type"},
		{`{"tool":"image-convert","format":"png"} {"tool":"pdf-compress"}`, "options=trailing-data"},
		{`{"tool":"image-resize","format":"png","resize":{"mode":"maxEdge","maxEdge":1.5}}`, "options.resize.maxEdge=invalid-type"},
	}
	for _, tc := range cases {
		_, de := decodeOptions(t, tc.in)
		if de == nil {
			t.Errorf("%s: erwartet Fehler", tc.in)
			continue
		}
		if got := fieldsOf(de); got != tc.want {
			t.Errorf("%s: erhalten %s, erwartet %s", tc.in, got, tc.want)
		}
	}
}

func TestOptionalMarshal(t *testing.T) {
	type wrap struct {
		A validation.Optional[int] `json:"a,omitzero"`
		B validation.Optional[int] `json:"b,omitzero"`
		C validation.Optional[int] `json:"c,omitzero"`
	}
	out, err := json.Marshal(wrap{A: validation.Some(0), B: validation.Null[int]()})
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != `{"a":0,"b":null}` {
		t.Fatalf("erhalten %s", out)
	}
	elem, ok := validation.OptionalElem(reflect.TypeFor[validation.Optional[[]string]]())
	if !ok || elem != reflect.TypeFor[[]string]() {
		t.Fatal("OptionalElem erkennt den Elementtyp nicht")
	}
}
