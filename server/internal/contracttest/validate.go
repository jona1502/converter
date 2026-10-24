package contracttest

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"slices"
	"strings"
)

// Schlüsselwörter ohne Prüfwirkung (Annotationen). discriminator ist durch
// oneOf vollständig abgedeckt.
var annotations = map[string]bool{
	"title": true, "description": true, "default": true, "discriminator": true,
	"examples": true,
}

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// Validate prüft JSON-Daten gegen ein Schema und liefert alle Verstöße.
func (s *Spec) Validate(schema Schema, data []byte) error {
	var v any
	if err := decodeNumbers(data, &v); err != nil {
		return fmt.Errorf("kein gültiges JSON: %w", err)
	}
	if problems := s.validate(schema, v, "$"); len(problems) > 0 {
		return errors.New(strings.Join(problems, "; "))
	}
	return nil
}

// ValidateComponent prüft Daten gegen eine benannte Komponente.
func (s *Spec) ValidateComponent(name string, data []byte) error {
	c, ok := s.Component(name)
	if !ok {
		return fmt.Errorf("Komponente %q fehlt", name)
	}
	return s.Validate(c, data)
}

func (s *Spec) validate(schema Schema, v any, at string) []string {
	var problems []string
	fail := func(format string, args ...any) {
		problems = append(problems, at+": "+fmt.Sprintf(format, args...))
	}

	for key := range schema {
		switch key {
		case "$ref", "type", "properties", "required", "additionalProperties", "enum", "const",
			"anyOf", "oneOf", "allOf", "items", "minItems", "maxItems", "minimum", "maximum",
			"exclusiveMinimum", "exclusiveMaximum", "pattern", "minLength", "maxLength", "format":
		default:
			if !annotations[key] {
				fail("nicht unterstütztes Schlüsselwort %q", key)
			}
		}
	}

	if ref, ok := schema["$ref"].(string); ok {
		target, _, err := s.resolve(ref)
		if err != nil {
			fail("%v", err)
			return problems
		}
		problems = append(problems, s.validate(target, v, at)...)
	}

	if t, ok := schema["type"]; ok {
		var types []string
		switch tt := t.(type) {
		case string:
			types = []string{tt}
		case []any:
			for _, x := range tt {
				if str, ok := x.(string); ok {
					types = append(types, str)
				}
			}
		}
		if !slices.ContainsFunc(types, func(name string) bool { return hasType(v, name) }) {
			fail("Typ %s erwartet, erhalten %s", strings.Join(types, "|"), typeName(v))
			return problems
		}
	}

	if enum, ok := schema["enum"].([]any); ok {
		if !slices.ContainsFunc(enum, func(e any) bool { return jsonEqual(e, v) }) {
			fail("Wert nicht in enum")
		}
	}
	if c, ok := schema["const"]; ok && !jsonEqual(c, v) {
		fail("Wert entspricht nicht const")
	}

	if branches, ok := schema["anyOf"].([]any); ok {
		matched := false
		for _, b := range branches {
			if len(s.validate(asSchema(b), v, at)) == 0 {
				matched = true
				break
			}
		}
		if !matched {
			fail("passt zu keinem anyOf-Zweig")
		}
	}
	if branches, ok := schema["oneOf"].([]any); ok {
		n := 0
		for _, b := range branches {
			if len(s.validate(asSchema(b), v, at)) == 0 {
				n++
			}
		}
		if n != 1 {
			fail("passt zu %d statt genau einem oneOf-Zweig", n)
		}
	}
	if branches, ok := schema["allOf"].([]any); ok {
		for _, b := range branches {
			problems = append(problems, s.validate(asSchema(b), v, at)...)
		}
	}

	switch val := v.(type) {
	case map[string]any:
		props, _ := schema["properties"].(map[string]any)
		if req, ok := schema["required"].([]any); ok {
			for _, r := range req {
				name, _ := r.(string)
				if _, present := val[name]; !present {
					fail("Pflichtfeld %q fehlt", name)
				}
			}
		}
		for name, fv := range val {
			if ps, ok := props[name]; ok {
				problems = append(problems, s.validate(asSchema(ps), fv, at+"."+name)...)
				continue
			}
			switch ap := schema["additionalProperties"].(type) {
			case bool:
				if !ap {
					fail("unerwartetes Feld %q", name)
				}
			case map[string]any:
				problems = append(problems, s.validate(ap, fv, at+"."+name)...)
			}
		}
	case []any:
		if items, ok := schema["items"].(map[string]any); ok {
			for i, item := range val {
				problems = append(problems, s.validate(items, item, fmt.Sprintf("%s[%d]", at, i))...)
			}
		}
		if n, ok := intKeyword(schema, "minItems"); ok && len(val) < n {
			fail("weniger als %d Einträge", n)
		}
		if n, ok := intKeyword(schema, "maxItems"); ok && len(val) > n {
			fail("mehr als %d Einträge", n)
		}
	case json.Number:
		x := toBig(val)
		check := func(key string, ok func(c int) bool) {
			if bound, present := schema[key].(json.Number); present && !ok(x.Cmp(toBig(bound))) {
				fail("%s verletzt", key)
			}
		}
		check("minimum", func(c int) bool { return c >= 0 })
		check("maximum", func(c int) bool { return c <= 0 })
		check("exclusiveMinimum", func(c int) bool { return c > 0 })
		check("exclusiveMaximum", func(c int) bool { return c < 0 })
	case string:
		if p, ok := schema["pattern"].(string); ok {
			re, err := regexp.Compile(p)
			if err != nil {
				fail("ungültiges pattern")
			} else if !re.MatchString(val) {
				fail("pattern verletzt")
			}
		}
		if n, ok := intKeyword(schema, "minLength"); ok && len([]rune(val)) < n {
			fail("kürzer als %d", n)
		}
		if n, ok := intKeyword(schema, "maxLength"); ok && len([]rune(val)) > n {
			fail("länger als %d", n)
		}
		if f, _ := schema["format"].(string); f == "uuid" && !uuidPattern.MatchString(val) {
			fail("keine UUID")
		}
	}
	return problems
}

func asSchema(v any) Schema {
	m, _ := v.(map[string]any)
	return m
}

func intKeyword(schema Schema, key string) (int, bool) {
	n, ok := schema[key].(json.Number)
	if !ok {
		return 0, false
	}
	i, err := n.Int64()
	return int(i), err == nil
}

func toBig(n json.Number) *big.Float {
	f, _, err := big.ParseFloat(string(n), 10, 256, big.ToNearestEven)
	if err != nil {
		return new(big.Float)
	}
	return f
}

func hasType(v any, name string) bool {
	switch name {
	case "null":
		return v == nil
	case "boolean":
		_, ok := v.(bool)
		return ok
	case "string":
		_, ok := v.(string)
		return ok
	case "object":
		_, ok := v.(map[string]any)
		return ok
	case "array":
		_, ok := v.([]any)
		return ok
	case "number":
		_, ok := v.(json.Number)
		return ok
	case "integer":
		n, ok := v.(json.Number)
		return ok && toBig(n).IsInt()
	}
	return false
}

func typeName(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case bool:
		return "boolean"
	case string:
		return "string"
	case map[string]any:
		return "object"
	case []any:
		return "array"
	case json.Number:
		return "number"
	}
	return fmt.Sprintf("%T", v)
}

func jsonEqual(a, b any) bool {
	an, aNum := a.(json.Number)
	bn, bNum := b.(json.Number)
	if aNum || bNum {
		return aNum && bNum && toBig(an).Cmp(toBig(bn)) == 0
	}
	switch av := a.(type) {
	case nil, bool, string:
		return a == b
	case []any:
		bv, ok := b.([]any)
		return ok && slices.EqualFunc(av, bv, jsonEqual)
	case map[string]any:
		bv, ok := b.(map[string]any)
		if !ok || len(av) != len(bv) {
			return false
		}
		for k, x := range av {
			y, ok := bv[k]
			if !ok || !jsonEqual(x, y) {
				return false
			}
		}
		return true
	}
	return false
}
