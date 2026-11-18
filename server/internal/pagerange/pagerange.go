// Package pagerange parst und prüft die Seitenbereichs-Syntax von pdf-split.
//
// Grammatik (streng, ASCII, ohne Leerraum):
//
//	liste  = bereich *( "," bereich )
//	bereich = zahl [ "-" [ zahl ] ]
//	zahl    = nichtnull *ziffer        (1 … MaxPageNumber, keine führenden Nullen)
//
// "7-" bedeutet: Seite 7 bis zur letzten Seite. Bereiche dürfen sich
// überlappen; jeder Bereich ergibt eine eigene Teil-PDF. Die gleiche Syntax
// prüfen der Konverter (Python) und der Browser (TypeScript); die gemeinsamen
// Testvektoren liegen in api/page-range-vectors.json.
package pagerange

import (
	"errors"
	"strings"
)

const (
	// MaxPageNumber ist die größte zulässige Seitenzahl in einer Angabe.
	MaxPageNumber = 99999
	// MaxRanges begrenzt die Zahl der Bereiche und damit der Ergebnisdateien.
	MaxRanges = 500
	// MaxLength begrenzt die Länge der Angabe in Bytes.
	MaxLength = 1024
)

// ErrSyntax meldet jede Verletzung der Grammatik oder der Grenzen.
var ErrSyntax = errors.New("pagerange: ungültige Seitenbereiche")

// Range ist ein Seitenbereich (1-basiert, einschließlich). End == 0 heißt:
// offen bis zur letzten Seite.
type Range struct {
	Start, End int
}

// Open meldet, ob der Bereich bis zur letzten Seite reicht.
func (r Range) Open() bool { return r.End == 0 }

// Parse prüft die Angabe vollständig und liefert die Bereiche in Eingabereihenfolge.
func Parse(spec string) ([]Range, error) {
	if spec == "" || len(spec) > MaxLength {
		return nil, ErrSyntax
	}
	items := strings.Split(spec, ",")
	if len(items) > MaxRanges {
		return nil, ErrSyntax
	}
	out := make([]Range, 0, len(items))
	for _, item := range items {
		start, rest, ok := number(item)
		if !ok {
			return nil, ErrSyntax
		}
		switch {
		case rest == "":
			out = append(out, Range{Start: start, End: start})
		case rest == "-":
			out = append(out, Range{Start: start})
		case rest[0] == '-':
			end, tail, ok := number(rest[1:])
			if !ok || tail != "" || end < start {
				return nil, ErrSyntax
			}
			out = append(out, Range{Start: start, End: end})
		default:
			return nil, ErrSyntax
		}
	}
	return out, nil
}

// number liest eine Zahl am Anfang; ok ist false ohne Ziffer, mit führender
// Null oder oberhalb von MaxPageNumber.
func number(s string) (value int, rest string, ok bool) {
	i := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		if i >= 6 {
			return 0, "", false
		}
		value = value*10 + int(s[i]-'0')
		i++
	}
	if i == 0 || s[0] == '0' || value > MaxPageNumber {
		return 0, "", false
	}
	return value, s[i:], true
}
