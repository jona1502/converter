// Package converter startet den privaten Python-Konverter
// (`python -I -m converter.cli run|probe`, siehe converter/converter/protocol.py)
// als isolierten Kindprozess, prüft sein JSONL-Ereignisprotokoll streng und
// verwaltet den Capabilities-Bericht. Pfade erzeugt ausschließlich Go.
package converter

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// ProtocolVersion ist die Version des Prozessprotokolls (Request und Probe).
const ProtocolVersion = 1

const (
	// MaxRequestBytes: Obergrenze der Anfrage über stdin (wie im Konverter).
	MaxRequestBytes = 64 * 1024
	// MaxLineBytes: Obergrenze einer Ereigniszeile inklusive Zeilenende.
	MaxLineBytes = 64 * 1024
	// MaxOptionsBytes: Optionsgrenze der API (Vertrag §4).
	MaxOptionsBytes = 8 * 1024
	maxPathBytes    = 4096
	maxMemory       = 1 << 40
	maxOutput       = 1 << 40
	maxTimeout      = time.Hour
)

// Fehlercodes (Vertrag §2), die Outcome.ErrorCode zusätzlich setzen kann.
const (
	CodeTimeout      = "timeout"
	CodeMemoryLimit  = "memory-limit"
	CodeWorkerFailed = "worker-failed"
)

// resultCodes: Codes, die der Konverter je Ergebnis melden darf.
var resultCodes = map[string]bool{
	"decode-failed": true, "encode-failed": true, "save-failed": true, "encrypted": true,
	"parse-failed": true, "not-pdf": true, "file-too-large": true, "result-too-large": true,
	"memory-limit": true, "dimensions-too-large": true, "animated-unsupported": true,
	"unsupported-type": true, "original-format-unsupported": true, "invalid-options": true,
	"duration-too-long": true, "unsupported-audio": true, "page-range-invalid": true,
}

// internalFatal sind interne Codes, die nie in der API erscheinen.
var internalFatal = map[string]bool{"protocol-error": true, "sandbox-failed": true, "worker-failed": true}

// PDF-Stufen in Vertragsreihenfolge.
var pdfLevels = map[string]bool{"high": true, "balanced": true, "small": true}

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// ErrInvalidRequest: der Aufrufer hat eine ungültige Anfrage gebaut (Go-Fehler).
var ErrInvalidRequest = errors.New("converter: ungültige Anfrage")

// Limits sind die Verarbeitungsgrenzen (Vertrag §6) für den Kindprozess.
type Limits struct {
	MarkdownMaxInputBytes   int64 `json:"markdownMaxInputBytes"`
	MarkdownMaxOutputBytes  int64 `json:"markdownMaxOutputBytes"`
	MarkdownMaxPages        int64 `json:"markdownMaxPages"`
	ImageMaxInputBytes      int64 `json:"imageMaxInputBytes"`
	ImageMaxPixels          int64 `json:"imageMaxPixels"`
	ImageMaxEdge            int64 `json:"imageMaxEdge"`
	ImageMaxOutputBytes     int64 `json:"imageMaxOutputBytes"`
	PdfMaxInputBytes        int64 `json:"pdfMaxInputBytes"`
	PdfMaxResultsTotalBytes int64 `json:"pdfMaxResultsTotalBytes"`
	PdfImageMaxPixels       int64 `json:"pdfImageMaxPixels"`
	AudioMaxInputBytes      int64 `json:"audioMaxInputBytes"`
	AudioMaxDurationSeconds int64 `json:"audioMaxDurationSeconds"`
	AudioMaxChannels        int64 `json:"audioMaxChannels"`
	AudioMaxSampleRate      int64 `json:"audioMaxSampleRate"`
	AudioMaxOutputBytes     int64 `json:"audioMaxOutputBytes"`
}

// DefaultLimits entspricht den Startwerten aus Vertrag §6.
func DefaultLimits() Limits {
	return Limits{
		MarkdownMaxInputBytes: 2_097_152, MarkdownMaxOutputBytes: 20_971_520, MarkdownMaxPages: 300,
		ImageMaxInputBytes:      52_428_800,
		ImageMaxPixels:          40_000_000,
		ImageMaxEdge:            16_384,
		ImageMaxOutputBytes:     104_857_600,
		PdfMaxInputBytes:        100_000_000,
		PdfMaxResultsTotalBytes: 300_000_000,
		PdfImageMaxPixels:       40_000_000,
		AudioMaxInputBytes:      104_857_600,
		AudioMaxDurationSeconds: 1800,
		AudioMaxChannels:        8,
		AudioMaxSampleRate:      192_000,
		AudioMaxOutputBytes:     419_430_400,
	}
}

func (l Limits) valid() bool {
	for _, v := range []int64{
		l.MarkdownMaxInputBytes, l.MarkdownMaxOutputBytes, l.MarkdownMaxPages,
		l.ImageMaxInputBytes, l.ImageMaxPixels, l.ImageMaxEdge, l.ImageMaxOutputBytes,
		l.PdfMaxInputBytes, l.PdfMaxResultsTotalBytes, l.PdfImageMaxPixels,
		l.AudioMaxInputBytes, l.AudioMaxDurationSeconds, l.AudioMaxChannels,
		l.AudioMaxSampleRate, l.AudioMaxOutputBytes,
	} {
		if v < 1 || v > maxJSONInt {
			return false
		}
	}
	return true
}

// ResultTarget ist eine von Go vorab leer angelegte Ergebnisdatei.
type ResultTarget struct {
	ID    string // kanonische UUID in Kleinbuchstaben
	Level string // "" bei Bildern und Audio, sonst high|balanced|small
	Path  string // absoluter Pfad, von Go erzeugt (O_EXCL, 0600)
}

// Request ist ein Konvertierungsauftrag. Bild und Audio: genau ein Ergebnis
// ohne Level. PDF: Ergebnisse in Verarbeitungsreihenfolge = options.levels.
type Request struct {
	Source  string          // absoluter Pfad der Eingabe
	Options json.RawMessage // bereits validierte Optionen (Vertrag §4)
	Results []ResultTarget
	Limits  Limits
	// MemoryBytes ist RLIMIT_AS des Kindprozesses.
	MemoryBytes int64
	// Timeout: Prozesszeitlimit (120 s Bild, 300 s PDF). Go beendet die
	// Prozessgruppe danach; der Kernel-Walltimer im Kind greift 1 s später.
	Timeout time.Duration
	// OutputLimit ist RLIMIT_FSIZE je Datei.
	OutputLimit int64
}

func (r Request) isPDF() bool { return len(r.Results) > 0 && r.Results[0].Level != "" }

// isAudio: options.tool ist audio-convert (Optionen sind bereits geprüft).
func (r Request) isMarkdown() bool {
	var head struct {
		Tool string `json:"tool"`
	}
	return json.Unmarshal(r.Options, &head) == nil && head.Tool == "markdown-pdf"
}

func (r Request) isAudio() bool {
	var head struct {
		Tool string `json:"tool"`
	}
	return json.Unmarshal(r.Options, &head) == nil && head.Tool == "audio-convert"
}

type wireResult struct {
	ID    string  `json:"id"`
	Level *string `json:"level"`
	Path  string  `json:"path"`
}

type wireRequest struct {
	ProtocolVersion int             `json:"protocolVersion"`
	Source          string          `json:"source"`
	Options         json.RawMessage `json:"options"`
	Results         []wireResult    `json:"results"`
	Limits          Limits          `json:"limits"`
	Memory          int64           `json:"memory"`
	Timeout         int64           `json:"timeout"`
	OutputLimit     int64           `json:"outputLimit"`
}

func invalid(reason string) error { return fmt.Errorf("%w: %s", ErrInvalidRequest, reason) }

func checkPath(p string) error {
	if p == "" || len(p) > maxPathBytes || strings.ContainsRune(p, 0) ||
		!strings.HasPrefix(p, "/") || filepath.Clean(p) != p {
		return invalid("Pfad muss absolut und bereinigt sein")
	}
	return nil
}

// encode prüft die Anfrage und erzeugt das Protokoll-JSON (≤ MaxRequestBytes).
func (r Request) encode() ([]byte, error) {
	if err := checkPath(r.Source); err != nil {
		return nil, err
	}
	opts := bytes.TrimSpace(r.Options)
	if len(opts) == 0 || len(opts) > MaxOptionsBytes || opts[0] != '{' || !json.Valid(opts) {
		return nil, invalid("Optionen müssen ein JSON-Objekt sein")
	}
	if len(r.Results) < 1 || len(r.Results) > 3 {
		return nil, invalid("1 bis 3 Ergebnisse")
	}
	pdf := r.isPDF()
	if !pdf && len(r.Results) != 1 {
		return nil, invalid("Bild/Audio hat genau ein Ergebnis")
	}
	if pdf && (r.isAudio() || r.isMarkdown() || r.isRotate() || r.isSplit()) {
		return nil, invalid("Audio ohne Stufe")
	}
	ids, paths, levels := map[string]bool{}, map[string]bool{r.Source: true}, map[string]bool{}
	wire := make([]wireResult, 0, len(r.Results))
	for _, t := range r.Results {
		if !uuidPattern.MatchString(t.ID) || ids[t.ID] {
			return nil, invalid("Ergebnis-ID")
		}
		if err := checkPath(t.Path); err != nil {
			return nil, err
		}
		if paths[t.Path] {
			return nil, invalid("Pfade müssen verschieden sein")
		}
		ids[t.ID], paths[t.Path] = true, true
		w := wireResult{ID: t.ID, Path: t.Path}
		if pdf {
			if !pdfLevels[t.Level] || levels[t.Level] {
				return nil, invalid("PDF-Stufe")
			}
			levels[t.Level] = true
			level := t.Level
			w.Level = &level
		} else if t.Level != "" {
			return nil, invalid("Bild ohne Stufe")
		}
		wire = append(wire, w)
	}
	if !r.Limits.valid() {
		return nil, invalid("Grenzwerte")
	}
	if r.MemoryBytes < 1 || r.MemoryBytes > maxMemory || r.OutputLimit < 1 || r.OutputLimit > maxOutput {
		return nil, invalid("memory/outputLimit")
	}
	if r.Timeout < time.Second || r.Timeout > maxTimeout {
		return nil, invalid("Timeout")
	}
	payload, err := json.Marshal(wireRequest{
		ProtocolVersion: ProtocolVersion,
		Source:          r.Source,
		Options:         opts,
		Results:         wire,
		Limits:          r.Limits,
		Memory:          r.MemoryBytes,
		Timeout:         int64(math.Ceil(r.Timeout.Seconds())),
		OutputLimit:     r.OutputLimit,
	})
	if err != nil {
		return nil, invalid("JSON")
	}
	if len(payload) > MaxRequestBytes {
		return nil, invalid("Anfrage zu groß")
	}
	return payload, nil
}
