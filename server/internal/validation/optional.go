package validation

import (
	"bytes"
	"encoding/json"
	"reflect"
)

// Optional unterscheidet für ein JSON-Feld drei Fälle: fehlend, null und
// Wert. Go-Nullwerte (0, false, "") sind damit von "nicht angegeben"
// unterscheidbar; z. B. wird quality 0 nie durch einen Standardwert ersetzt.
//
// Beim Serialisieren zusammen mit `json:",omitzero"` verwenden, damit ein
// fehlender Wert auch ausgelassen wird. Ob null zulässig ist, entscheidet
// das Feld: mit dem Tag `strict:"notnull"` lehnt DecodeStrict null ab.
type Optional[T any] struct {
	value   T
	present bool
	null    bool
}

// Some liefert einen gesetzten Wert.
func Some[T any](v T) Optional[T] { return Optional[T]{value: v, present: true} }

// Null liefert ein ausdrücklich auf null gesetztes Feld.
func Null[T any]() Optional[T] { return Optional[T]{present: true, null: true} }

// Set meldet, ob das Feld in der Eingabe vorkam (auch als null).
func (o Optional[T]) Set() bool { return o.present }

// Null meldet, ob das Feld ausdrücklich null war.
func (o Optional[T]) Null() bool { return o.present && o.null }

// Value liefert den Wert, falls das Feld gesetzt und nicht null ist.
func (o Optional[T]) Value() (T, bool) {
	if o.present && !o.null {
		return o.value, true
	}
	var zero T
	return zero, false
}

// Or liefert den Wert oder – wenn fehlend oder null – def.
func (o Optional[T]) Or(def T) T {
	if v, ok := o.Value(); ok {
		return v
	}
	return def
}

// IsZero: fehlend. Grundlage für `omitzero`.
func (o Optional[T]) IsZero() bool { return !o.present }

func (o Optional[T]) MarshalJSON() ([]byte, error) {
	if v, ok := o.Value(); ok {
		return json.Marshal(v)
	}
	return []byte("null"), nil
}

func (o *Optional[T]) UnmarshalJSON(data []byte) error {
	o.present = true
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		var zero T
		o.value, o.null = zero, true
		return nil
	}
	o.null = false
	return json.Unmarshal(data, &o.value)
}

// optionalElem erlaubt DecodeStrict, den Elementtyp zu erkennen.
func (o Optional[T]) optionalElem() reflect.Type { return reflect.TypeFor[T]() }

type optionalMarker interface{ optionalElem() reflect.Type }

var optionalMarkerType = reflect.TypeFor[optionalMarker]()

// OptionalElem liefert für einen Optional-Typ dessen Elementtyp.
func OptionalElem(t reflect.Type) (reflect.Type, bool) {
	if t.Kind() == reflect.Struct && t.Implements(optionalMarkerType) {
		return reflect.Zero(t).Interface().(optionalMarker).optionalElem(), true
	}
	return nil, false
}

// Union beschreibt eine über ein Diskriminatorfeld unterschiedene Variante
// (OpenAPI oneOf + discriminator), z. B. resize.mode oder options.tool.
// Implementierungen brauchen zusätzlich UnmarshalJSON/MarshalJSON; DecodeStrict
// prüft die gewählte Variante vorher streng.
type Union interface {
	// UnionDiscriminator: Name des Diskriminatorfelds.
	UnionDiscriminator() string
	// UnionVariant liefert einen Zeiger auf eine leere Variante oder nil,
	// wenn der Diskriminatorwert unbekannt ist.
	UnionVariant(tag string) any
}

var unionType = reflect.TypeFor[Union]()

// UnionVariants ist für Vertragstests: liefert für den Typ t (Union) die
// Variante zum Diskriminatorwert.
func UnionVariants(t reflect.Type, tag string) (discriminator string, variant reflect.Type, ok bool) {
	if !reflect.PointerTo(t).Implements(unionType) {
		return "", nil, false
	}
	u := reflect.New(t).Interface().(Union)
	v := u.UnionVariant(tag)
	if v == nil {
		return u.UnionDiscriminator(), nil, true
	}
	return u.UnionDiscriminator(), reflect.TypeOf(v).Elem(), true
}
