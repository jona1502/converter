// Package validation enthält den strikten JSON-Decoder und typisierte
// Eingabehilfen. Fachliche Regeln (z. B. ICO mit Resize) prüfen die
// Aufrufer nach dem Dekodieren.
package validation

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"
)

// Begrenzung der Fehlerliste wie im Python-Backend (errors.py).
const (
	MaxFieldErrors      = 20
	MaxFieldPathLength  = 64
	DefaultMaxDepth     = 16
	rootPathPlaceholder = "body"
)

// Fehlerarten in FieldError.Code.
const (
	CodeMissing          = "missing"
	CodeUnknownField     = "unknown-field"
	CodeDuplicateKey     = "duplicate-key"
	CodeInvalidType      = "invalid-type"
	CodeOutOfRange       = "out-of-range"
	CodeInvalidJSON      = "invalid-json"
	CodeTrailingData     = "trailing-data"
	CodeTooDeep          = "too-deep"
	CodeTooLarge         = "too-large"
	CodeUnionTagNotFound = "union-tag-not-found"
	CodeUnionTagInvalid  = "union-tag-invalid"
	CodeInvalidValue     = "invalid-value"
)

// Kind fasst einen DecodeError zusammen.
type Kind string

const (
	KindTooLarge    Kind = "too-large"    // Eingabe über dem Größenlimit
	KindInvalidJSON Kind = "invalid-json" // Syntax, UTF-8, nachfolgende Werte
	KindTooDeep     Kind = "too-deep"     // Verschachtelung über dem Limit
	KindInvalid     Kind = "invalid"      // Struktur passt nicht zum Zieltyp
)

// FieldError: Pfad und Fehlerart, nie der Eingabewert.
type FieldError struct {
	Path string
	Code string
}

// DecodeError enthält ausschließlich Pfade und Fehlerarten. Error() gibt
// keine Eingabewerte aus und darf deshalb geloggt werden.
type DecodeError struct {
	Kind   Kind
	Fields []FieldError
}

func (e *DecodeError) Error() string {
	return fmt.Sprintf("ungültiges JSON (%s, %d Feldfehler)", e.Kind, len(e.Fields))
}

// Limits für DecodeStrict.
type Limits struct {
	MaxBytes int64 // > 0 Pflicht
	MaxDepth int   // 0 = DefaultMaxDepth
}

// DecodeStrict liest höchstens lim.MaxBytes aus r und dekodiert genau einen
// JSON-Wert nach dst (Zeiger). Abgelehnt werden: zu große Eingabe, ungültiges
// UTF-8/JSON, nachfolgende Werte, zu tiefe Verschachtelung, unbekannte oder
// doppelte Felder, abweichende Groß-/Kleinschreibung von Feldnamen, falsche
// Typen, null für nicht-nullbare Felder, fehlende Pflichtfelder sowie Zahlen
// außerhalb des Zieltyps.
//
// Pflichtfeld ist jedes Strukturfeld, das weder Zeiger, Optional, Interface
// noch mit omitempty/omitzero markiert ist. prefix wird jedem Pfad
// vorangestellt (z. B. "options"); Fehler sind *DecodeError.
func DecodeStrict(r io.Reader, lim Limits, prefix string, dst any) error {
	if lim.MaxBytes <= 0 {
		return errors.New("validation: MaxBytes fehlt")
	}
	data, err := io.ReadAll(io.LimitReader(r, lim.MaxBytes+1))
	if err != nil {
		return err
	}
	if int64(len(data)) > lim.MaxBytes {
		return tooLarge(prefix)
	}
	return DecodeStrictBytes(data, lim, prefix, dst)
}

// DecodeStrictBytes wie DecodeStrict für bereits gelesene Bytes.
func DecodeStrictBytes(data []byte, lim Limits, prefix string, dst any) error {
	rv := reflect.ValueOf(dst)
	if rv.Kind() != reflect.Pointer || rv.IsNil() {
		return errors.New("validation: dst muss ein Zeiger sein")
	}
	if lim.MaxBytes > 0 && int64(len(data)) > lim.MaxBytes {
		return tooLarge(prefix)
	}
	if lim.MaxDepth <= 0 {
		lim.MaxDepth = DefaultMaxDepth
	}
	if !utf8.Valid(data) {
		return syntaxError(prefix, CodeInvalidJSON)
	}

	st := &state{maxDepth: lim.MaxDepth, prefix: prefix}
	w := newWalker(data, st)
	if err := w.value(rv.Type().Elem(), nil, 0, false); err != nil {
		return st.result(err)
	}
	if _, err := w.dec.Token(); err != io.EOF {
		if err == nil {
			return syntaxError(prefix, CodeTrailingData)
		}
		return syntaxError(prefix, CodeInvalidJSON)
	}
	if len(st.fields) > 0 {
		return &DecodeError{Kind: KindInvalid, Fields: st.fields}
	}

	// Struktur ist geprüft; jetzt nur noch befüllen.
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		var ute *json.UnmarshalTypeError
		path := ""
		if errors.As(err, &ute) {
			path = ute.Field
		}
		return &DecodeError{Kind: KindInvalid, Fields: []FieldError{{Path: joinPath(prefix, splitDots(path)), Code: CodeInvalidValue}}}
	}
	return nil
}

func tooLarge(prefix string) error {
	return &DecodeError{Kind: KindTooLarge, Fields: []FieldError{{Path: joinPath(prefix, nil), Code: CodeTooLarge}}}
}

func syntaxError(prefix, code string) error {
	return &DecodeError{Kind: KindInvalidJSON, Fields: []FieldError{{Path: joinPath(prefix, nil), Code: code}}}
}

func splitDots(p string) []string {
	if p == "" {
		return nil
	}
	return strings.Split(p, ".")
}

// joinPath baut den Pfad wie errors.py: Segmente mit ".", auf 64 Zeichen
// gekürzt, leerer Pfad → "body".
func joinPath(prefix string, segs []string) string {
	parts := make([]string, 0, len(segs)+1)
	if prefix != "" {
		parts = append(parts, prefix)
	}
	parts = append(parts, segs...)
	p := strings.Join(parts, ".")
	if utf8.RuneCountInString(p) > MaxFieldPathLength {
		p = string([]rune(p)[:MaxFieldPathLength])
	}
	if p == "" {
		return rootPathPlaceholder
	}
	return p
}

// --- Strukturprüfung über den Tokenstrom --------------------------------

var (
	errSyntax  = errors.New("syntax")
	errTooDeep = errors.New("too deep")
	errFull    = errors.New("zu viele Fehler")
)

type state struct {
	maxDepth int
	prefix   string
	fields   []FieldError
	seen     map[FieldError]bool
}

func (s *state) add(path []string, code string) error {
	fe := FieldError{Path: joinPath(s.prefix, path), Code: code}
	if s.seen == nil {
		s.seen = map[FieldError]bool{}
	}
	if s.seen[fe] {
		return nil
	}
	s.seen[fe] = true
	s.fields = append(s.fields, fe)
	if len(s.fields) >= MaxFieldErrors {
		return errFull
	}
	return nil
}

func (s *state) result(err error) error {
	switch {
	case errors.Is(err, errSyntax):
		return syntaxError(s.prefix, CodeInvalidJSON)
	case errors.Is(err, errTooDeep):
		return &DecodeError{Kind: KindTooDeep, Fields: []FieldError{{Path: joinPath(s.prefix, nil), Code: CodeTooDeep}}}
	case errors.Is(err, errFull):
		return &DecodeError{Kind: KindInvalid, Fields: s.fields}
	}
	return err
}

type walker struct {
	data []byte
	dec  *json.Decoder
	st   *state
}

func newWalker(data []byte, st *state) *walker {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	return &walker{data: data, dec: dec, st: st}
}

func (w *walker) token() (json.Token, error) {
	tok, err := w.dec.Token()
	if err != nil {
		return nil, errSyntax
	}
	return tok, nil
}

var (
	rawMessageType  = reflect.TypeFor[json.RawMessage]()
	unmarshalerType = reflect.TypeFor[json.Unmarshaler]()
)

func appendPath(path []string, seg string) []string {
	out := make([]string, len(path), len(path)+1)
	copy(out, path)
	return append(out, seg)
}

// value prüft genau einen Wert gegen t. depth = Tiefe des umgebenden Containers.
func (w *walker) value(t reflect.Type, path []string, depth int, notNull bool) error {
	start := w.dec.InputOffset()
	tok, err := w.token()
	if err != nil {
		return err
	}

	nullable := false
	for {
		if elem, ok := OptionalElem(t); ok {
			nullable = nullable || !notNull
			t = elem
			continue
		}
		if t.Kind() == reflect.Pointer {
			nullable = true
			t = t.Elem()
			continue
		}
		break
	}

	if tok == nil {
		if nullable || t.Kind() == reflect.Interface || t == rawMessageType ||
			(reflect.PointerTo(t).Implements(unmarshalerType) && !reflect.PointerTo(t).Implements(unionType)) {
			return nil
		}
		return w.st.add(path, CodeInvalidType)
	}

	if reflect.PointerTo(t).Implements(unionType) {
		return w.union(t, tok, start, path, depth)
	}
	// Eigene Unmarshaler (z. B. Zeitstempel) und freie Werte nur
	// syntaktisch/auf Tiefe prüfen; die Methode prüft den Inhalt selbst.
	if t.Kind() == reflect.Interface || t == rawMessageType || reflect.PointerTo(t).Implements(unmarshalerType) {
		return w.skip(tok, depth)
	}

	switch t.Kind() {
	case reflect.Struct:
		return w.object(t, tok, path, depth)
	case reflect.Map:
		return w.mapValue(t, tok, path, depth)
	case reflect.Slice, reflect.Array:
		if t.Kind() == reflect.Slice && t.Elem().Kind() == reflect.Uint8 {
			// []byte ist in encoding/json ein Base64-String.
			if _, ok := tok.(string); !ok {
				return w.mismatch(tok, path, depth)
			}
			return nil
		}
		return w.array(t, tok, path, depth)
	case reflect.String:
		if _, ok := tok.(string); !ok {
			return w.mismatch(tok, path, depth)
		}
		return nil
	case reflect.Bool:
		if _, ok := tok.(bool); !ok {
			return w.mismatch(tok, path, depth)
		}
		return nil
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		n, ok := tok.(json.Number)
		if !ok {
			return w.mismatch(tok, path, depth)
		}
		if _, err := strconv.ParseInt(string(n), 10, t.Bits()); err != nil {
			return w.numErr(err, path)
		}
		return nil
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		n, ok := tok.(json.Number)
		if !ok {
			return w.mismatch(tok, path, depth)
		}
		if strings.HasPrefix(string(n), "-") {
			if _, err := strconv.ParseInt(string(n), 10, 64); err == nil {
				return w.st.add(path, CodeOutOfRange)
			}
		}
		if _, err := strconv.ParseUint(string(n), 10, t.Bits()); err != nil {
			return w.numErr(err, path)
		}
		return nil
	case reflect.Float32, reflect.Float64:
		n, ok := tok.(json.Number)
		if !ok {
			return w.mismatch(tok, path, depth)
		}
		// JSON kennt kein NaN/Infinity; Überlauf ergäbe ±Inf.
		if _, err := strconv.ParseFloat(string(n), t.Bits()); err != nil {
			return w.numErr(err, path)
		}
		return nil
	}
	return fmt.Errorf("validation: Typ %s wird nicht unterstützt", t)
}

func (w *walker) numErr(err error, path []string) error {
	if errors.Is(err, strconv.ErrRange) {
		return w.st.add(path, CodeOutOfRange)
	}
	return w.st.add(path, CodeInvalidType)
}

// mismatch meldet einen Typfehler und überspringt den restlichen Wert.
func (w *walker) mismatch(tok json.Token, path []string, depth int) error {
	if err := w.st.add(path, CodeInvalidType); err != nil {
		return err
	}
	return w.skip(tok, depth)
}

func (w *walker) open(depth int) error {
	if depth+1 > w.st.maxDepth {
		return errTooDeep
	}
	return nil
}

// skip überspringt den Rest eines Werts, dessen erstes Token tok ist.
func (w *walker) skip(tok json.Token, depth int) error {
	d, ok := tok.(json.Delim)
	if !ok || d == '}' || d == ']' {
		return nil
	}
	if err := w.open(depth); err != nil {
		return err
	}
	level := depth + 1
	for level > depth {
		tok, err := w.token()
		if err != nil {
			return err
		}
		if d, ok := tok.(json.Delim); ok {
			switch d {
			case '{', '[':
				if err := w.open(level); err != nil {
					return err
				}
				level++
			default:
				level--
			}
		}
	}
	return nil
}

type fieldInfo struct {
	name     string
	index    []int
	typ      reflect.Type
	required bool
	notNull  bool
}

var fieldCache sync.Map // reflect.Type → []fieldInfo

// StructFields liefert die JSON-Felder einer Struktur nach den Regeln von
// DecodeStrict (auch für Vertragstests).
func StructFields(t reflect.Type) []FieldInfo {
	fs := fieldsOf(t)
	out := make([]FieldInfo, len(fs))
	for i, f := range fs {
		out[i] = FieldInfo{Name: f.name, Type: f.typ, Required: f.required, NotNull: f.notNull, Index: f.index}
	}
	return out
}

// FieldInfo beschreibt ein JSON-Feld einer Struktur.
type FieldInfo struct {
	Name     string
	Type     reflect.Type
	Required bool // muss in der Eingabe vorkommen bzw. wird immer ausgegeben
	NotNull  bool // Optional mit `strict:"notnull"`
	Index    []int
}

func fieldsOf(t reflect.Type) []fieldInfo {
	if v, ok := fieldCache.Load(t); ok {
		return v.([]fieldInfo)
	}
	var out []fieldInfo
	var collect func(t reflect.Type, index []int)
	collect = func(t reflect.Type, index []int) {
		for i := range t.NumField() {
			f := t.Field(i)
			tag := f.Tag.Get("json")
			if tag == "-" {
				continue
			}
			name, opts, _ := strings.Cut(tag, ",")
			idx := append(append([]int(nil), index...), i)
			if f.Anonymous && name == "" && f.Type.Kind() == reflect.Struct {
				if _, isOpt := OptionalElem(f.Type); !isOpt {
					collect(f.Type, idx)
					continue
				}
			}
			if !f.IsExported() {
				continue
			}
			if name == "" {
				name = f.Name
			}
			omit := hasOpt(opts, "omitempty") || hasOpt(opts, "omitzero")
			_, isOpt := OptionalElem(f.Type)
			k := f.Type.Kind()
			required := !omit && !isOpt && k != reflect.Pointer && k != reflect.Interface
			out = append(out, fieldInfo{
				name:     name,
				index:    idx,
				typ:      f.Type,
				required: required,
				notNull:  f.Tag.Get("strict") == "notnull",
			})
		}
	}
	collect(t, nil)
	fieldCache.Store(t, out)
	return out
}

func hasOpt(opts, want string) bool {
	for o := range strings.SplitSeq(opts, ",") {
		if o == want {
			return true
		}
	}
	return false
}

func (w *walker) object(t reflect.Type, tok json.Token, path []string, depth int) error {
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return w.mismatch(tok, path, depth)
	}
	if err := w.open(depth); err != nil {
		return err
	}
	fields := fieldsOf(t)
	seen := make(map[string]bool, len(fields))
	for w.dec.More() {
		kt, err := w.token()
		if err != nil {
			return err
		}
		key, _ := kt.(string)
		var fi *fieldInfo
		for i := range fields {
			// Exakter Vergleich: encoding/json würde "Quality" sonst
			// stillschweigend auf "quality" abbilden.
			if fields[i].name == key {
				fi = &fields[i]
				break
			}
		}
		switch {
		case fi == nil:
			// Name des unbekannten Schlüssels stammt vom Client und wird
			// nicht wiedergegeben – nur das umgebende Objekt.
			if err := w.st.add(path, CodeUnknownField); err != nil {
				return err
			}
			if err := w.skipValue(depth + 1); err != nil {
				return err
			}
		case seen[key]:
			if err := w.st.add(appendPath(path, key), CodeDuplicateKey); err != nil {
				return err
			}
			if err := w.skipValue(depth + 1); err != nil {
				return err
			}
		default:
			seen[key] = true
			if err := w.value(fi.typ, appendPath(path, key), depth+1, fi.notNull); err != nil {
				return err
			}
		}
	}
	if _, err := w.token(); err != nil { // '}'
		return err
	}
	for _, f := range fields {
		if f.required && !seen[f.name] {
			if err := w.st.add(appendPath(path, f.name), CodeMissing); err != nil {
				return err
			}
		}
	}
	return nil
}

func (w *walker) skipValue(depth int) error {
	tok, err := w.token()
	if err != nil {
		return err
	}
	return w.skip(tok, depth)
}

func (w *walker) mapValue(t reflect.Type, tok json.Token, path []string, depth int) error {
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return w.mismatch(tok, path, depth)
	}
	if t.Key().Kind() != reflect.String {
		return fmt.Errorf("validation: Map-Schlüssel %s wird nicht unterstützt", t.Key())
	}
	if err := w.open(depth); err != nil {
		return err
	}
	seen := map[string]bool{}
	for w.dec.More() {
		kt, err := w.token()
		if err != nil {
			return err
		}
		key, _ := kt.(string)
		if seen[key] {
			if err := w.st.add(appendPath(path, key), CodeDuplicateKey); err != nil {
				return err
			}
			if err := w.skipValue(depth + 1); err != nil {
				return err
			}
			continue
		}
		seen[key] = true
		if err := w.value(t.Elem(), appendPath(path, key), depth+1, false); err != nil {
			return err
		}
	}
	_, err := w.token()
	return err
}

func (w *walker) array(t reflect.Type, tok json.Token, path []string, depth int) error {
	if d, ok := tok.(json.Delim); !ok || d != '[' {
		return w.mismatch(tok, path, depth)
	}
	if err := w.open(depth); err != nil {
		return err
	}
	i := 0
	for w.dec.More() {
		if t.Kind() == reflect.Array && i >= t.Len() {
			if err := w.st.add(path, CodeOutOfRange); err != nil {
				return err
			}
			if err := w.skipValue(depth + 1); err != nil {
				return err
			}
			i++
			continue
		}
		if err := w.value(t.Elem(), appendPath(path, strconv.Itoa(i)), depth+1, false); err != nil {
			return err
		}
		i++
	}
	_, err := w.token()
	return err
}

// union prüft eine Diskriminator-Variante: Rohbytes des Objekts erfassen,
// Diskriminator lesen und das Objekt erneut streng gegen die Variante prüfen.
func (w *walker) union(t reflect.Type, tok json.Token, start int64, path []string, depth int) error {
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return w.mismatch(tok, path, depth)
	}
	if err := w.skip(tok, depth); err != nil {
		return err
	}
	raw := bytes.TrimLeft(w.data[start:w.dec.InputOffset()], " \t\r\n:,")

	u := reflect.New(t).Interface().(Union)
	var head map[string]json.RawMessage
	if err := json.Unmarshal(raw, &head); err != nil {
		return errSyntax
	}
	tagRaw, ok := head[u.UnionDiscriminator()]
	if !ok {
		return w.st.add(path, CodeUnionTagNotFound)
	}
	var tag string
	if err := json.Unmarshal(tagRaw, &tag); err != nil {
		return w.st.add(path, CodeUnionTagInvalid)
	}
	variant := u.UnionVariant(tag)
	if variant == nil {
		return w.st.add(path, CodeUnionTagInvalid)
	}
	sub := newWalker(raw, w.st)
	return sub.value(reflect.TypeOf(variant).Elem(), path, depth, false)
}
