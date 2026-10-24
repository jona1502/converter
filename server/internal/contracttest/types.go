package contracttest

import (
	"fmt"
	"reflect"
	"slices"
	"sort"
	"strings"

	"miconverter/server/internal/validation"
)

// Types ordnet Vertragskomponenten Go-Typen zu.
type Types struct {
	byName  map[string]reflect.Type
	names   map[reflect.Type][]string // ein Go-Typ kann mehrere Enums abdecken
	values  map[reflect.Type][]string // Enum-Werte eines Go-Typs
	strings map[reflect.Type]bool     // Typen, die als JSON-String serialisieren
	objects map[reflect.Type]bool     // freie Objekte (object, additionalProperties: true, nullable)
}

func NewTypes() *Types {
	return &Types{
		byName:  map[string]reflect.Type{},
		names:   map[reflect.Type][]string{},
		values:  map[reflect.Type][]string{},
		strings: map[reflect.Type]bool{},
		objects: map[reflect.Type]bool{},
	}
}

// Component ordnet eine Objekt- oder Union-Komponente einem Go-Typ zu.
func (ts *Types) Component(name string, t reflect.Type) {
	ts.byName[name] = t
	ts.names[t] = append(ts.names[t], name)
}

// Enum ordnet eine Enum-Komponente (name, leer für Inline-Enums) einem
// Go-Typ samt seiner Werte zu.
func Enum[T ~string](ts *Types, name string, values []T) {
	t := reflect.TypeFor[T]()
	if name != "" {
		ts.Component(name, t)
	}
	vs := make([]string, len(values))
	for i, v := range values {
		vs[i] = string(v)
	}
	ts.values[t] = vs
}

// Alias: Go-Typ deckt zusätzlich die Komponente name ab (z. B. ein
// Fehlercode, der ProcessingErrorCode oder ApiErrorCode sein darf).
func (ts *Types) Alias(name string, t reflect.Type) { ts.names[t] = append(ts.names[t], name) }

// StringType: t serialisiert als JSON-String (z. B. Zeitstempel).
func (ts *Types) StringType(t reflect.Type) { ts.strings[t] = true }

// ObjectType: t ist ein freies, nullbares JSON-Objekt.
func (ts *Types) ObjectType(t reflect.Type) { ts.objects[t] = true }

// Registered liefert den Go-Typ einer Komponente.
func (ts *Types) Registered(name string) (reflect.Type, bool) {
	t, ok := ts.byName[name]
	return t, ok
}

// CheckComponent vergleicht eine Komponente mit ihrem Go-Typ: Properties,
// Pflichtfelder, Nullbarkeit, Typen und Enum-Werte.
func (s *Spec) CheckComponent(ts *Types, name string) []string {
	schema, ok := s.Component(name)
	if !ok {
		return []string{name + ": Komponente fehlt im Vertrag"}
	}
	t, ok := ts.byName[name]
	if !ok {
		return []string{name + ": kein Go-Typ registriert"}
	}
	switch {
	case schema["enum"] != nil:
		return checkEnum(name, schema, t, ts)
	case schema["oneOf"] != nil:
		return s.checkUnion(name, schema, t, ts)
	default:
		return s.checkStruct(name, schema, t, ts)
	}
}

func checkEnum(at string, schema Schema, t reflect.Type, ts *Types) []string {
	want := stringsOf(schema["enum"])
	got, ok := ts.values[t]
	if !ok {
		return []string{fmt.Sprintf("%s: keine Enum-Werte für %s registriert", at, t)}
	}
	if !sameSet(want, got) {
		return []string{fmt.Sprintf("%s: Enum-Werte weichen ab: Vertrag %v, Go %v", at, sorted(want), sorted(got))}
	}
	return nil
}

func (s *Spec) checkStruct(at string, schema Schema, t reflect.Type, ts *Types) []string {
	if t.Kind() != reflect.Struct {
		return []string{fmt.Sprintf("%s: Struktur erwartet, Go-Typ %s", at, t)}
	}
	var problems []string
	fail := func(format string, args ...any) { problems = append(problems, at+fmt.Sprintf(format, args...)) }

	props, _ := schema["properties"].(map[string]any)
	required := stringsOf(schema["required"])
	fields := map[string]validation.FieldInfo{}
	for _, f := range validation.StructFields(t) {
		fields[f.Name] = f
	}

	for name, raw := range props {
		prop := asSchema(raw)
		f, ok := fields[name]
		if !ok {
			fail(".%s: Feld fehlt in %s", name, t)
			continue
		}
		sf := t.FieldByIndex(f.Index)
		always := !tagHas(sf.Tag.Get("json"), "omitempty") && !tagHas(sf.Tag.Get("json"), "omitzero")
		if _, isOpt := validation.OptionalElem(f.Type); isOpt && always {
			fail(".%s: Optional ohne omitzero", name)
		}
		schemaRequired := slices.Contains(required, name)
		if schemaRequired != always {
			// Ein nicht verpflichtendes Feld mit Standardwert darf immer
			// ausgegeben werden (z. B. LiveResponse.status = "ok").
			_, hasDefault := prop["default"]
			if schemaRequired || !hasDefault || f.Type.Kind() == reflect.Pointer {
				fail(".%s: Pflichtfeld laut Vertrag %v, in Go immer vorhanden %v", name, schemaRequired, always)
			}
		}
		inner, nullable := splitNullable(prop)
		if goNullable(f, always, ts) != nullable {
			fail(".%s: nullable laut Vertrag %v, Go-Typ %s (notnull=%v)", name, nullable, f.Type, f.NotNull)
		}
		problems = append(problems, s.compareType(at+"."+name, inner, f.Type, ts)...)
	}
	if ap, ok := schema["additionalProperties"].(bool); ok && !ap {
		for name := range fields {
			if _, ok := props[name]; !ok {
				fail(".%s: Go-Feld fehlt im Vertrag", name)
			}
		}
	}
	return problems
}

// goNullable: kann das Feld null tragen bzw. wird ein nil-Wert ausgelassen
// statt als null ausgegeben (Slices/Maps mit omitempty)?
func goNullable(f validation.FieldInfo, always bool, ts *Types) bool {
	if _, ok := validation.OptionalElem(f.Type); ok {
		return !f.NotNull
	}
	switch f.Type.Kind() {
	case reflect.Pointer, reflect.Interface:
		return true
	case reflect.Slice, reflect.Map:
		if ts.objects[f.Type] {
			return true
		}
		return !always
	}
	return false
}

func splitNullable(prop Schema) (Schema, bool) {
	branches, ok := prop["anyOf"].([]any)
	if !ok {
		return prop, false
	}
	var rest []any
	nullable := false
	for _, b := range branches {
		if bs := asSchema(b); len(bs) == 1 && bs["type"] == "null" {
			nullable = true
			continue
		}
		rest = append(rest, b)
	}
	if !nullable {
		return prop, false
	}
	if len(rest) == 1 {
		return asSchema(rest[0]), true
	}
	return Schema{"anyOf": rest}, true
}

func (s *Spec) compareType(at string, schema Schema, t reflect.Type, ts *Types) []string {
	for {
		if elem, ok := validation.OptionalElem(t); ok {
			t = elem
			continue
		}
		if t.Kind() == reflect.Pointer {
			t = t.Elem()
			continue
		}
		break
	}
	if len(schema) == 0 {
		return nil
	}
	if ref, ok := schema["$ref"].(string); ok {
		_, name, err := s.resolve(ref)
		if err != nil {
			return []string{at + ": " + err.Error()}
		}
		if !slices.Contains(ts.names[t], name) {
			return []string{fmt.Sprintf("%s: Vertrag verweist auf %s, Go-Typ %s ist dafür nicht registriert", at, name, t)}
		}
		return nil
	}
	if schema["oneOf"] != nil {
		return s.checkUnion(at, schema, t, ts)
	}
	if branches, ok := schema["anyOf"].([]any); ok {
		var all []string
		for _, b := range branches {
			p := s.compareType(at, asSchema(b), t, ts)
			if len(p) == 0 {
				return nil
			}
			all = append(all, p...)
		}
		return []string{fmt.Sprintf("%s: kein anyOf-Zweig passt (%s)", at, strings.Join(all, "; "))}
	}

	typ, _ := schema["type"].(string)
	k := t.Kind()
	switch typ {
	case "string":
		if k != reflect.String && !ts.strings[t] {
			return []string{fmt.Sprintf("%s: string erwartet, Go %s", at, t)}
		}
		var want []string
		if e, ok := schema["enum"]; ok {
			want = stringsOf(e)
		}
		if c, ok := schema["const"].(string); ok {
			want = []string{c}
		}
		if want != nil && t.Name() != "string" {
			got, ok := ts.values[t]
			if !ok {
				return []string{fmt.Sprintf("%s: Inline-Enum, aber keine Werte für %s registriert", at, t)}
			}
			for _, w := range want {
				if !slices.Contains(got, w) {
					return []string{fmt.Sprintf("%s: Wert %q fehlt in %s", at, w, t)}
				}
			}
		}
	case "integer":
		if k < reflect.Int || k > reflect.Uint64 || k == reflect.Uintptr {
			return []string{fmt.Sprintf("%s: integer erwartet, Go %s", at, t)}
		}
	case "number":
		if k != reflect.Float32 && k != reflect.Float64 {
			return []string{fmt.Sprintf("%s: number erwartet, Go %s", at, t)}
		}
	case "boolean":
		if k != reflect.Bool {
			return []string{fmt.Sprintf("%s: boolean erwartet, Go %s", at, t)}
		}
	case "array":
		if (k != reflect.Slice && k != reflect.Array) || ts.objects[t] {
			return []string{fmt.Sprintf("%s: array erwartet, Go %s", at, t)}
		}
		return s.compareType(at+"[]", asSchema(schema["items"]), t.Elem(), ts)
	case "object":
		if _, hasProps := schema["properties"]; hasProps {
			return []string{at + ": Inline-Objekt mit properties wird nicht unterstützt"}
		}
		switch ap := schema["additionalProperties"].(type) {
		case map[string]any:
			if k != reflect.Map || t.Key().Kind() != reflect.String {
				return []string{fmt.Sprintf("%s: Map erwartet, Go %s", at, t)}
			}
			return s.compareType(at+"{}", ap, t.Elem(), ts)
		default:
			if ts.objects[t] || k == reflect.Interface || (k == reflect.Map && t.Key().Kind() == reflect.String) {
				return nil
			}
			return []string{fmt.Sprintf("%s: freies Objekt erwartet, Go %s", at, t)}
		}
	default:
		return []string{fmt.Sprintf("%s: Schema ohne unterstützten Typ", at)}
	}
	return nil
}

func (s *Spec) checkUnion(at string, schema Schema, t reflect.Type, ts *Types) []string {
	disc := asSchema(schema["discriminator"])
	prop, _ := disc["propertyName"].(string)
	mapping, _ := disc["mapping"].(map[string]any)
	if prop == "" || len(mapping) == 0 {
		return []string{at + ": oneOf ohne discriminator wird nicht unterstützt"}
	}
	var problems []string
	for tag, raw := range mapping {
		ref, _ := raw.(string)
		_, name, err := s.resolve(ref)
		if err != nil {
			problems = append(problems, at+": "+err.Error())
			continue
		}
		gotProp, variant, ok := validation.UnionVariants(t, tag)
		switch {
		case !ok:
			problems = append(problems, fmt.Sprintf("%s: Go-Typ %s ist keine validation.Union", at, t))
			return problems
		case gotProp != prop:
			problems = append(problems, fmt.Sprintf("%s: Diskriminator Vertrag %q, Go %q", at, prop, gotProp))
		case variant == nil:
			problems = append(problems, fmt.Sprintf("%s: Go kennt Variante %q nicht", at, tag))
		case !slices.Contains(ts.names[variant], name):
			problems = append(problems, fmt.Sprintf("%s: Variante %q ist %s, Vertrag %s", at, tag, variant, name))
		}
	}
	if _, v, _ := validation.UnionVariants(t, "\x00unbekannt"); v != nil {
		problems = append(problems, at+": unbekannter Diskriminatorwert wird akzeptiert")
	}
	return problems
}

func tagHas(tag, opt string) bool {
	_, opts, _ := strings.Cut(tag, ",")
	return slices.Contains(strings.Split(opts, ","), opt)
}

func stringsOf(v any) []string {
	list, _ := v.([]any)
	out := make([]string, 0, len(list))
	for _, x := range list {
		out = append(out, fmt.Sprint(x))
	}
	return out
}

func sameSet(a, b []string) bool {
	return slices.Equal(sorted(a), sorted(b))
}

func sorted(in []string) []string {
	out := slices.Clone(in)
	sort.Strings(out)
	return out
}
