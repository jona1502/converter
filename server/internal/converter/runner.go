package converter

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"
)

// Kind ist die Art eines an den Aufrufer gereichten Ereignisses.
type Kind string

const (
	KindProgress Kind = "progress"
	KindAnalysis Kind = "analysis"
	KindResult   Kind = "result"
	KindError    Kind = "error"
)

// Progress: echte Zähler einer PDF-Stufe (variant) bzw. der Audio-Frames
// (encode, ohne level).
type Progress struct {
	Step    string `json:"step"`
	Level   string `json:"level,omitempty"`
	Current int64  `json:"current"`
	Total   int64  `json:"total"`
}

// Event ist ein geprüftes Ereignis. fatal wird nicht ausgeliefert, sondern
// erscheint im Outcome.
type Event struct {
	Kind     Kind
	Phase    string          // progress: "encode" (Bild, Audio) | "variant" (PDF)
	Progress *Progress       // Phase "variant"; bei Audio optional mit Phase "encode"
	Analysis json.RawMessage // analysis: geprüft und neu kodiert (PdfAnalysis)
	ResultID string          // result/error: ID aus dem Request
	Level    string          // result/error: Stufe ("" bei Bildern)
	Path     string          // result: von Go erzeugter Pfad aus dem Request
	Size     int64           // result: Größe aus dem Dateisystem (Lstat)
	Details  json.RawMessage // result: geprüft und neu kodiert
	Code     string          // error: Fehlercode (Vertrag §2)
}

// Outcome fasst einen Lauf zusammen. ErrorCode == "" heißt: Prozess sauber
// beendet und jedes Ergebnis per result oder error abgeschlossen. Sonst gilt
// ErrorCode für den Auftrag und alle nicht abgeschlossenen Ergebnisse.
type Outcome struct {
	ErrorCode   string
	Reason      string   // interne Diagnose für Logs, ohne Pfade/Inhalte
	Finished    []string // abgeschlossene Ergebnis-IDs in Reihenfolge
	ExitCode    int      // -1 bei Signal
	Signal      string   // beendendes Signal, z. B. "killed"
	StderrBytes int64
	Events      int
	Duration    time.Duration
}

// ErrCallback: der onEvent-Callback hat einen Fehler gemeldet (z. B. Lease
// verloren); die Prozessgruppe wurde beendet.
var ErrCallback = errors.New("converter: Callback abgebrochen")

// Fehler der Ergebnisprüfung.
var (
	ErrNotRegular      = errors.New("converter: Ergebnis ist keine reguläre Datei")
	ErrEmptyResult     = errors.New("converter: Ergebnis ist leer")
	ErrResultTooLarge  = errors.New("converter: Ergebnis überschreitet die Grenze")
	errResultsMismatch = errors.New("converter: Ergebnisse unvollständig")
)

// CheckResult misst eine Ergebnisdatei im Dateisystem (Lstat: reguläre
// Datei, kein Symlink) und prüft 0 < Größe ≤ limit. Die Größenbehauptung des
// Parsers zählt nicht.
func CheckResult(path string, limit int64) (int64, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return 0, fmt.Errorf("converter: Ergebnis: %w", err)
	}
	if !info.Mode().IsRegular() {
		return 0, ErrNotRegular
	}
	if info.Size() == 0 {
		return 0, ErrEmptyResult
	}
	if info.Size() > limit {
		return info.Size(), ErrResultTooLarge
	}
	return info.Size(), nil
}

// session ist der Protokollzustand eines Laufs.
type session struct {
	req       Request
	pdf       bool
	audio     bool
	markdown  bool
	rotate    bool
	split     bool
	onEvent   func(Event) error
	analysis  bool
	next      int // Index des nächsten offenen Ergebnisses
	usedBytes int64
	fatal     string
	finished  []string
}

func (s *session) deliver(ev Event) error {
	if err := s.onEvent(ev); err != nil {
		return &callbackError{err: err}
	}
	return nil
}

func (s *session) target(o object) (ResultTarget, error) {
	id, err := o.str("id", 36)
	if err != nil {
		return ResultTarget{}, violated("id")
	}
	if s.pdf && !s.analysis {
		return ResultTarget{}, violated("Ergebnis vor analysis")
	}
	for i, t := range s.req.Results {
		if t.ID != id {
			continue
		}
		switch {
		case i < s.next:
			return ResultTarget{}, violated("doppelter Abschluss")
		case i > s.next:
			return ResultTarget{}, violated("Ergebnis außer Reihenfolge")
		}
		return t, nil
	}
	return ResultTarget{}, violated("unbekannte Ergebnis-ID")
}

func (s *session) finish(t ResultTarget) {
	s.finished = append(s.finished, t.ID)
	s.next++
}

func (s *session) handle(data []byte) error {
	if s.fatal != "" {
		return violated("Ereignis nach fatal")
	}
	if s.next >= len(s.req.Results) {
		return violated("Ereignis nach letztem Ergebnis")
	}
	head, err := parseObject(data, []string{"kind"},
		[]string{"phase", "progress", "analysis", "id", "details", "code"})
	if err != nil {
		return violated("Ereignis kein gültiges Objekt")
	}
	kind, err := head.str("kind", 16)
	if err != nil {
		return violated("kind")
	}
	switch kind {
	case "progress":
		return s.progress(data)
	case "analysis":
		o, err := parseObject(data, []string{"kind", "analysis"}, nil)
		if err != nil || !s.pdf || s.analysis {
			return violated("analysis unerwartet")
		}
		analysis, err := ValidatePdfAnalysis(o["analysis"])
		if err != nil {
			return violated("analysis ungültig")
		}
		s.analysis = true
		return s.deliver(Event{Kind: KindAnalysis, Analysis: analysis})
	case "result":
		o, err := parseObject(data, []string{"kind", "id", "details"}, nil)
		if err != nil {
			return violated("result-Felder")
		}
		t, err := s.target(o)
		if err != nil {
			return err
		}
		var details json.RawMessage
		switch {
		case s.pdf:
			details, err = ValidatePdfDetails(o["details"])
		case s.rotate:
			details, err = ValidatePdfRotateDetails(o["details"])
		case s.markdown:
			details, err = ValidateMarkdownDetails(o["details"], s.req.Limits)
		case s.split:
			details, err = ValidateSplitDetails(o["details"])
		case s.audio:
			details, err = ValidateAudioDetails(o["details"], s.req.Limits)
		default:
			details, err = ValidateImageDetails(o["details"], s.req.Limits)
		}
		if err != nil {
			return violated("details ungültig")
		}
		limit := s.req.Limits.ImageMaxOutputBytes
		switch {
		case s.pdf:
			limit = s.req.Limits.PdfMaxResultsTotalBytes - s.usedBytes
		case s.rotate:
			limit = s.req.Limits.PdfMaxResultsTotalBytes
		case s.markdown:
			limit = s.req.Limits.MarkdownMaxOutputBytes
		case s.split:
			limit = s.req.Limits.PdfMaxResultsTotalBytes
		case s.audio:
			limit = s.req.Limits.AudioMaxOutputBytes
		}
		size, err := CheckResult(t.Path, limit)
		s.finish(t)
		if errors.Is(err, ErrResultTooLarge) {
			// Grenze im Dateisystem verletzt: als Ergebnisfehler behandeln.
			return s.deliver(Event{Kind: KindError, ResultID: t.ID, Level: t.Level, Code: "result-too-large"})
		}
		if err != nil {
			return violated("Ergebnisdatei ungültig")
		}
		s.usedBytes += size
		return s.deliver(Event{Kind: KindResult, ResultID: t.ID, Level: t.Level, Path: t.Path, Size: size, Details: details})
	case "error":
		o, err := parseObject(data, []string{"kind", "id", "code"}, nil)
		if err != nil {
			return violated("error-Felder")
		}
		t, err := s.target(o)
		if err != nil {
			return err
		}
		code, err := o.str("code", 40)
		if err != nil || !resultCodes[code] {
			return violated("unbekannter Ergebniscode")
		}
		s.finish(t)
		return s.deliver(Event{Kind: KindError, ResultID: t.ID, Level: t.Level, Code: code})
	case "fatal":
		o, err := parseObject(data, []string{"kind", "code"}, nil)
		if err != nil {
			return violated("fatal-Felder")
		}
		code, err := o.str("code", 40)
		if err != nil || !(resultCodes[code] || internalFatal[code]) {
			return violated("unbekannter fatal-Code")
		}
		s.fatal = code
		return nil
	}
	return violated("unbekanntes kind")
}

func (s *session) progress(data []byte) error {
	if !s.pdf {
		var optional []string
		if s.audio {
			optional = []string{"progress"}
		}
		o, err := parseObject(data, []string{"kind", "phase"}, optional)
		if err != nil {
			return violated("progress-Felder")
		}
		if phase, err := o.str("phase", 16); err != nil || phase != "encode" {
			return violated("progress-Phase")
		}
		if _, ok := o["progress"]; !ok {
			return s.deliver(Event{Kind: KindProgress, Phase: "encode"})
		}
		p, err := o.nested("progress", []string{"step", "current", "total"}, nil)
		if err != nil {
			return violated("progress-Objekt")
		}
		step, err1 := p.str("step", 16)
		total, err2 := p.integer("total", 0, 1<<40)
		current, err3 := p.integer("current", 0, total)
		if errors.Join(err1, err2, err3) != nil || step != "encode" {
			return violated("progress-Werte")
		}
		return s.deliver(Event{Kind: KindProgress, Phase: "encode",
			Progress: &Progress{Step: step, Current: current, Total: total}})
	}
	if !s.analysis {
		return violated("progress vor analysis")
	}
	o, err := parseObject(data, []string{"kind", "phase", "progress"}, nil)
	if err != nil {
		return violated("progress-Felder")
	}
	if phase, err := o.str("phase", 16); err != nil || phase != "variant" {
		return violated("progress-Phase")
	}
	p, err := o.nested("progress", []string{"step", "level", "current", "total"}, nil)
	if err != nil {
		return violated("progress-Objekt")
	}
	step, err1 := p.str("step", 16)
	level, err2 := p.str("level", 16)
	total, err3 := p.integer("total", 0, 1<<31)
	current, err4 := p.integer("current", 0, total)
	if errors.Join(err1, err2, err3, err4) != nil || step != "variant" {
		return violated("progress-Werte")
	}
	if level != s.req.Results[s.next].Level {
		return violated("progress-Stufe")
	}
	return s.deliver(Event{Kind: KindProgress, Phase: "variant",
		Progress: &Progress{Step: step, Level: level, Current: current, Total: total}})
}

// Run führt einen Auftrag im Kindprozess aus und ruft onEvent für jedes
// geprüfte Ereignis synchron auf. Fehler von onEvent beenden die
// Prozessgruppe; Run liefert dann ErrCallback. Bei ctx-Abbruch liefert Run
// ctx.Err(). Fehlverhalten des Kindes (Protokoll, Flut, Signal, Zeitlimit)
// ist kein error, sondern Outcome.ErrorCode. Run kehrt immer erst nach Wait
// zurück.
func (r *Runner) Run(ctx context.Context, req Request, onEvent func(Event) error) (Outcome, error) {
	payload, err := req.encode()
	if err != nil {
		return Outcome{}, err
	}
	s := &session{req: req, pdf: req.isPDF(), audio: req.isAudio(), markdown: req.isMarkdown(), rotate: req.isRotate(), split: req.isSplit(), onEvent: onEvent}
	res, err := r.execute(ctx, "run", payload, req.Timeout, s.handle)
	if err != nil {
		return Outcome{}, err
	}
	out := Outcome{
		Finished:    s.finished,
		StderrBytes: res.stderrBytes,
		Events:      res.lines,
		Duration:    res.duration,
		ExitCode:    res.state.ExitCode(),
	}
	sig, signaled := exitSignal(res.state)
	if signaled {
		out.Signal = sig.String()
	}
	var cbErr *callbackError
	var viol *violation
	switch {
	case errors.As(res.cause, &cbErr):
		out.ErrorCode, out.Reason = CodeWorkerFailed, "callback"
		return out, fmt.Errorf("%w: %w", ErrCallback, cbErr.err)
	case ctx.Err() != nil:
		out.ErrorCode, out.Reason = CodeWorkerFailed, "abgebrochen"
		return out, ctx.Err()
	case errors.As(res.cause, &viol):
		out.ErrorCode, out.Reason = CodeWorkerFailed, viol.reason
	case errors.Is(res.cause, errDeadline):
		out.ErrorCode, out.Reason = CodeTimeout, "Zeitlimit"
	case res.cause != nil:
		out.ErrorCode, out.Reason = CodeWorkerFailed, res.cause.Error()
	case s.fatal != "":
		out.ErrorCode, out.Reason = s.fatal, "fatal"
		if internalFatal[s.fatal] {
			out.ErrorCode = CodeWorkerFailed
			out.Reason = "fatal " + s.fatal
		}
	case signaled:
		out.ErrorCode, out.Reason = signalCode(sig, false), "Signal "+sig.String()
	case res.waitErr != nil || out.ExitCode != 0:
		out.ErrorCode, out.Reason = CodeWorkerFailed, fmt.Sprintf("Exit %d", out.ExitCode)
	case s.next != len(req.Results):
		out.ErrorCode, out.Reason = CodeWorkerFailed, errResultsMismatch.Error()
	}
	return out, nil
}
