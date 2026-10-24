package config

import (
	"fmt"
	"log/slog"
)

const redacted = "[redigiert]"

// Secret hält einen geheimen Wert (Schlüssel, URL mit Passwort). Alle
// üblichen Ausgabewege – fmt (%v, %+v, %#v, %s, %q), JSON, slog – zeigen nur
// "[redigiert]"; den Klartext liefert ausschließlich Reveal.
//
// Der Wert liegt hinter einem Zeiger: Gibt fmt eine Struktur mit einem
// unexportierten Secret-Feld aus (dort greift Format nicht), erscheint nur
// eine Adresse, nie der Inhalt.
type Secret struct {
	value *string
}

// NewSecret erzeugt ein gesetztes Secret.
func NewSecret(v string) Secret { return Secret{value: &v} }

// Reveal liefert den Klartext. Nur zur Übergabe an Treiber/Kryptofunktionen.
func (s Secret) Reveal() string {
	if s.value == nil {
		return ""
	}
	return *s.value
}

// IsSet meldet, ob ein Wert konfiguriert ist.
func (s Secret) IsSet() bool { return s.value != nil }

func (s Secret) String() string   { return redacted }
func (s Secret) GoString() string { return redacted }

// Format deckt alle Verben ab, auch %x oder %d, die String() umgehen würden.
func (s Secret) Format(f fmt.State, _ rune) { _, _ = f.Write([]byte(redacted)) }

func (s Secret) MarshalJSON() ([]byte, error) { return []byte(`"` + redacted + `"`), nil }
func (s Secret) MarshalText() ([]byte, error) { return []byte(redacted), nil }
func (s Secret) LogValue() slog.Value         { return slog.StringValue(redacted) }
