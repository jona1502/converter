package converter

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
)

// Kleine strikte JSON-Hilfen. encoding/json allein genügt nicht: es ordnet
// Schlüssel ohne Beachtung der Groß-/Kleinschreibung zu, akzeptiert doppelte
// Schlüssel und lässt null bei Zahlen/Booleans stillschweigend zu.

var errJSON = errors.New("ungültiges JSON")

// maxJSONInt ist die größte Ganzzahl, die verlustfrei durch JSON/float64 geht.
const maxJSONInt = 1 << 53

type object map[string]json.RawMessage

// parseObject liest genau ein JSON-Objekt und prüft die Schlüsselmenge exakt
// (Groß-/Kleinschreibung zählt, keine Duplikate, keine Daten danach).
func parseObject(raw []byte, required, optional []string) (object, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	tok, err := dec.Token()
	if err != nil || tok != json.Delim('{') {
		return nil, fmt.Errorf("%w: Objekt erwartet", errJSON)
	}
	allowed := make(map[string]bool, len(required)+len(optional))
	for _, k := range required {
		allowed[k] = true
	}
	for _, k := range optional {
		allowed[k] = true
	}
	out := object{}
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return nil, fmt.Errorf("%w: Schlüssel", errJSON)
		}
		key, ok := tok.(string)
		if !ok {
			return nil, fmt.Errorf("%w: Schlüssel", errJSON)
		}
		if !allowed[key] {
			return nil, fmt.Errorf("%w: unbekanntes Feld", errJSON)
		}
		if _, dup := out[key]; dup {
			return nil, fmt.Errorf("%w: doppeltes Feld", errJSON)
		}
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nil, fmt.Errorf("%w: Wert", errJSON)
		}
		out[key] = value
	}
	if tok, err := dec.Token(); err != nil || tok != json.Delim('}') {
		return nil, fmt.Errorf("%w: Objektende", errJSON)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("%w: Daten nach dem Objekt", errJSON)
	}
	for _, k := range required {
		if _, ok := out[k]; !ok {
			return nil, fmt.Errorf("%w: Pflichtfeld fehlt", errJSON)
		}
	}
	return out, nil
}

func isNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

func (o object) str(key string, maxLen int) (string, error) {
	raw := o[key]
	if isNull(raw) {
		return "", fmt.Errorf("%w: %s", errJSON, key)
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil || len(s) > maxLen {
		return "", fmt.Errorf("%w: %s", errJSON, key)
	}
	return s, nil
}

func (o object) boolean(key string) (bool, error) {
	raw := bytes.TrimSpace(o[key])
	switch string(raw) {
	case "true":
		return true, nil
	case "false":
		return false, nil
	}
	return false, fmt.Errorf("%w: %s", errJSON, key)
}

// integer akzeptiert nur JSON-Ganzzahlen ohne Bruch-/Exponentteil.
func (o object) integer(key string, minimum, maximum int64) (int64, error) {
	raw := bytes.TrimSpace(o[key])
	if len(raw) == 0 || bytes.ContainsAny(raw, ".eE") || isNull(raw) {
		return 0, fmt.Errorf("%w: %s", errJSON, key)
	}
	var n int64
	if err := json.Unmarshal(raw, &n); err != nil || n < minimum || n > maximum {
		return 0, fmt.Errorf("%w: %s", errJSON, key)
	}
	return n, nil
}

// number akzeptiert eine endliche JSON-Zahl (keine Strings, kein null).
func (o object) number(key string, minimum, maximum float64) (float64, error) {
	raw := bytes.TrimSpace(o[key])
	if len(raw) == 0 || isNull(raw) || raw[0] == '"' {
		return 0, fmt.Errorf("%w: %s", errJSON, key)
	}
	var n float64
	if err := json.Unmarshal(raw, &n); err != nil || math.IsNaN(n) || n < minimum || n > maximum {
		return 0, fmt.Errorf("%w: %s", errJSON, key)
	}
	return n, nil
}

func (o object) nested(key string, required, optional []string) (object, error) {
	return parseObject(o[key], required, optional)
}

// array liefert die Rohwerte eines JSON-Arrays mit Längengrenze.
func (o object) array(key string, maxItems int) ([]json.RawMessage, error) {
	raw := o[key]
	if isNull(raw) {
		return nil, fmt.Errorf("%w: %s", errJSON, key)
	}
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil || len(items) > maxItems {
		return nil, fmt.Errorf("%w: %s", errJSON, key)
	}
	return items, nil
}

func stringList(items []json.RawMessage, maxLen int) ([]string, error) {
	out := make([]string, 0, len(items))
	seen := map[string]bool{}
	for _, item := range items {
		if isNull(item) {
			return nil, errJSON
		}
		var s string
		if err := json.Unmarshal(item, &s); err != nil || len(s) > maxLen || seen[s] {
			return nil, errJSON
		}
		seen[s] = true
		out = append(out, s)
	}
	return out, nil
}
