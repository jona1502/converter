package jobs

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"
)

// ErrNotCanonical meldet einen Wert, den Pythons canonical_json nicht oder
// anders darstellen würde (NaN/Inf, ungültiges UTF-8, unbekannter Typ).
var ErrNotCanonical = errors.New("jobs: Wert nicht kanonisch darstellbar")

// CanonicalJSON erzeugt byte-genau dieselbe Darstellung wie Pythons
//
//	json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
//
// (app/schemas/options.py canonical_json). Erlaubte Werte: nil, bool,
// string, int/int32/int64, float64, []any, map[string]any und vorab
// kanonische json.RawMessage. float64 wird immer als Python-float
// geschrieben (1 → "1.0", 1e-05, 1e+16), ganzzahlige Typen ohne
// Nachkommastelle – entscheidend für Optionen wie quality/percent, die
// Pydantic als float ausgibt.
func CanonicalJSON(v any) ([]byte, error) {
	var b bytes.Buffer
	if err := writeCanonical(&b, v); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}

func writeCanonical(b *bytes.Buffer, v any) error {
	switch x := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if x {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case string:
		return writeString(b, x)
	case int:
		b.WriteString(strconv.FormatInt(int64(x), 10))
	case int32:
		b.WriteString(strconv.FormatInt(int64(x), 10))
	case int64:
		b.WriteString(strconv.FormatInt(x, 10))
	case float64:
		s, err := pythonFloat(x)
		if err != nil {
			return err
		}
		b.WriteString(s)
	case json.RawMessage:
		if !json.Valid(x) {
			return ErrNotCanonical
		}
		b.Write(x)
	case []any:
		b.WriteByte('[')
		for i, item := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			if err := writeCanonical(b, item); err != nil {
				return err
			}
		}
		b.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		// Bytevergleich von UTF-8 entspricht der Codepoint-Ordnung von Python.
		slices.Sort(keys)
		b.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				b.WriteByte(',')
			}
			if err := writeString(b, k); err != nil {
				return err
			}
			b.WriteByte(':')
			if err := writeCanonical(b, x[k]); err != nil {
				return err
			}
		}
		b.WriteByte('}')
	default:
		return fmt.Errorf("%w: Typ %T", ErrNotCanonical, v)
	}
	return nil
}

// writeString escapt wie Pythons json mit ensure_ascii=False: nur ", \ und
// Steuerzeichen < 0x20; alles andere (auch U+2028, <, >, &) bleibt roh.
func writeString(b *bytes.Buffer, s string) error {
	if !utf8.ValidString(s) {
		return ErrNotCanonical
	}
	const hexDigits = "0123456789abcdef"
	b.WriteByte('"')
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch c {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		default:
			if c < 0x20 {
				b.WriteString(`\u00`)
				b.WriteByte(hexDigits[c>>4])
				b.WriteByte(hexDigits[c&0xf])
			} else {
				b.WriteByte(c)
			}
		}
	}
	b.WriteByte('"')
	return nil
}

// pythonFloat entspricht float.__repr__: kürzeste Ziffernfolge, Festkomma
// für -4 < Dezimalexponent <= 16, sonst wissenschaftlich mit mindestens
// zweistelligem, vorzeichenbehaftetem Exponenten.
func pythonFloat(f float64) (string, error) {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return "", ErrNotCanonical
	}
	if f == 0 {
		if math.Signbit(f) {
			return "-0.0", nil
		}
		return "0.0", nil
	}
	e := strconv.FormatFloat(f, 'e', -1, 64) // z. B. "-1.2345e+06"
	sign := ""
	if e[0] == '-' {
		sign, e = "-", e[1:]
	}
	mantissa, expText, _ := strings.Cut(e, "e")
	exp, err := strconv.Atoi(expText)
	if err != nil {
		return "", ErrNotCanonical
	}
	digits := strings.Replace(mantissa, ".", "", 1)
	decpt := exp + 1 // Position des Dezimalpunkts relativ zu digits

	if decpt <= -4 || decpt > 16 {
		out := digits[:1]
		if len(digits) > 1 {
			out += "." + digits[1:]
		}
		expSign := "+"
		if exp < 0 {
			expSign, exp = "-", -exp
		}
		expDigits := strconv.Itoa(exp)
		if len(expDigits) < 2 {
			expDigits = "0" + expDigits
		}
		return sign + out + "e" + expSign + expDigits, nil
	}
	switch {
	case decpt <= 0:
		return sign + "0." + strings.Repeat("0", -decpt) + digits, nil
	case decpt >= len(digits):
		return sign + digits + strings.Repeat("0", decpt-len(digits)) + ".0", nil
	default:
		return sign + digits[:decpt] + "." + digits[decpt:], nil
	}
}

// Fingerprint ist der Idempotenz-Fingerabdruck wie acceptance.fingerprint:
// SHA-256 über canonical_json({"tool", "options", "fileSha256", "fileSize"}).
// canonicalOptions muss bereits die Python-kanonische Form der Optionen
// (mit angewendeten Standardwerten) sein, z. B. aus CanonicalJSON.
func Fingerprint(tool string, canonicalOptions json.RawMessage, fileSHA256 [32]byte, fileSize int64) ([32]byte, error) {
	payload, err := CanonicalJSON(map[string]any{
		"tool":       tool,
		"options":    canonicalOptions,
		"fileSha256": hex.EncodeToString(fileSHA256[:]),
		"fileSize":   fileSize,
	})
	if err != nil {
		return [32]byte{}, err
	}
	return sha256.Sum256(payload), nil
}
