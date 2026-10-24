package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"unicode/utf8"

	"miconverter/server/internal/apitypes"
	"miconverter/server/internal/validation"
)

// Begrenzung der Feldfehler in Antworten (wie errors.py).
const (
	MaxFieldErrors     = validation.MaxFieldErrors
	MaxFieldPathLength = validation.MaxFieldPathLength
)

// Error ist ein fachlicher API-Fehler; WriteError übersetzt ihn in das
// Vertragsformat {"error": {...}, "requestId": "..."}. Message ist ein
// kurzer technischer Text ohne Pfade, Dateinamen oder Interna.
type Error struct {
	Status  int
	Code    apitypes.ApiErrorCode
	Message string
	// Sekunden bis zum nächsten Versuch; nur bei 429/503 ausgegeben
	// (Feld retryAfterSeconds und Header Retry-After).
	RetryAfter *int
	// Nur bei Validierungsfehlern; Pfade und Fehlerarten, nie Werte.
	Fields []apitypes.FieldError
}

func (e *Error) Error() string {
	return fmt.Sprintf("api: %d %s", e.Status, e.Code)
}

// NewError erzeugt einen API-Fehler.
func NewError(status int, code apitypes.ApiErrorCode, message string) *Error {
	return &Error{Status: status, Code: code, Message: message}
}

// WithRetryAfter liefert eine Kopie mit Wartezeit in Sekunden.
func (e *Error) WithRetryAfter(seconds int) *Error {
	c := *e
	c.RetryAfter = &seconds
	return &c
}

// WithFields liefert eine Kopie mit Feldfehlern.
func (e *Error) WithFields(fields ...apitypes.FieldError) *Error {
	c := *e
	c.Fields = append([]apitypes.FieldError(nil), fields...)
	return &c
}

// Internal: unerwarteter Fehler; nur die requestId dient der Diagnose.
func Internal() *Error {
	return NewError(http.StatusInternalServerError, apitypes.CodeInternalError, "Interner Fehler.")
}

// ServiceUnavailable: benötigte Abhängigkeit (z. B. Datenbank) nicht
// erreichbar; wie im Python-Backend mit Retry-After 5.
func ServiceUnavailable() *Error {
	return NewError(http.StatusServiceUnavailable, apitypes.CodeServiceUnavailable, "Dienst nicht verfügbar.").WithRetryAfter(5)
}

// StatusError bildet einen reinen HTTP-Status auf das Vertragsformat ab
// (wie _handle_http_exception): 404 not-found, 405 method-not-allowed,
// 413 file-too-large, 503 service-unavailable, übrige 4xx invalid-request,
// übrige 5xx einheitlich 500 internal-error.
func StatusError(status int) *Error {
	switch {
	case status == http.StatusNotFound:
		return NewError(status, apitypes.CodeNotFound, "Ressource nicht gefunden.")
	case status == http.StatusMethodNotAllowed:
		return NewError(status, apitypes.CodeMethodNotAllowed, "Methode nicht erlaubt.")
	case status == http.StatusRequestEntityTooLarge:
		return NewError(status, apitypes.CodeFileTooLarge, "Anfrage ist zu groß.")
	case status == http.StatusServiceUnavailable:
		return NewError(status, apitypes.CodeServiceUnavailable, "Dienst nicht verfügbar.")
	case status >= 400 && status < 500:
		return NewError(status, apitypes.CodeInvalidRequest, "Anfrage ist ungültig.")
	}
	return Internal()
}

// InvalidRequest erzeugt 422 invalid-request aus einem Decoderfehler.
func InvalidRequest(err error) *Error {
	e := NewError(http.StatusUnprocessableEntity, apitypes.CodeInvalidRequest, "Anfrage ist ungültig.")
	var de *validation.DecodeError
	if errors.As(err, &de) {
		fields := make([]apitypes.FieldError, len(de.Fields))
		for i, f := range de.Fields {
			fields[i] = apitypes.FieldError{Path: f.Path, Code: f.Code}
		}
		e.Fields = fields
	}
	return e
}

// WriteError schreibt err im Vertragsformat. Ist err kein *Error, wird nur
// sein Typ geloggt (der Text kann Pfade oder Hostnamen enthalten) und 500
// internal-error geantwortet.
func WriteError(w http.ResponseWriter, r *http.Request, err error) {
	var apiErr *Error
	if !errors.As(err, &apiErr) {
		Logger(r.Context()).LogAttrs(r.Context(), slog.LevelError, "Unerwarteter Fehler",
			slog.String("errorType", fmt.Sprintf("%T", err)))
		apiErr = Internal()
	}
	status := apiErr.Status
	if status < 400 || status > 599 {
		status = http.StatusInternalServerError
	}

	detail := apitypes.ErrorDetail{Code: apiErr.Code, Message: apiErr.Message, Fields: limitFields(apiErr.Fields)}
	if apiErr.RetryAfter != nil && (status == http.StatusTooManyRequests || status == http.StatusServiceUnavailable) {
		seconds := max(*apiErr.RetryAfter, 0)
		detail.RetryAfterSeconds = &seconds
		w.Header().Set("Retry-After", strconv.Itoa(seconds))
	}
	WriteJSON(w, status, apitypes.ErrorResponse{Error: detail, RequestID: requestIDOrNew(r.Context())})
}

// limitFields begrenzt Anzahl und Pfadlänge und entfernt Duplikate, damit
// eine Anfrage keine beliebig große Fehlerantwort erzeugt.
func limitFields(in []apitypes.FieldError) []apitypes.FieldError {
	if len(in) == 0 {
		return nil
	}
	out := make([]apitypes.FieldError, 0, min(len(in), MaxFieldErrors))
	seen := map[apitypes.FieldError]bool{}
	for _, f := range in {
		if utf8.RuneCountInString(f.Path) > MaxFieldPathLength {
			f.Path = string([]rune(f.Path)[:MaxFieldPathLength])
		}
		if f.Path == "" {
			f.Path = "body"
		}
		if seen[f] {
			continue
		}
		seen[f] = true
		out = append(out, f)
		if len(out) == MaxFieldErrors {
			break
		}
	}
	return out
}

// WriteJSON serialisiert v und schreibt es mit Status und Content-Length.
// Scheitert die Serialisierung, wird 500 internal-error geschrieben.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		buf.Reset()
		status = http.StatusInternalServerError
		_ = json.NewEncoder(&buf).Encode(apitypes.ErrorResponse{
			Error:     apitypes.ErrorDetail{Code: apitypes.CodeInternalError, Message: "Interner Fehler."},
			RequestID: w.Header().Get("X-Request-Id"),
		})
	}
	body := bytes.TrimSuffix(buf.Bytes(), []byte("\n"))
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// HandlerFunc ist ein Handler, der Fehler zurückgibt statt sie selbst zu
// schreiben. Ein Fehler darf nur zurückgegeben werden, solange noch nichts
// geschrieben wurde.
type HandlerFunc func(w http.ResponseWriter, r *http.Request) error

func (f HandlerFunc) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if err := f(w, r); err != nil {
		if rec, ok := w.(*recorder); ok && rec.wroteHeader {
			// Antwort läuft bereits; abbrechen statt einen zweiten Status zu senden.
			Logger(r.Context()).LogAttrs(r.Context(), slog.LevelError, "Fehler nach Antwortbeginn",
				slog.String("errorType", fmt.Sprintf("%T", err)))
			panic(http.ErrAbortHandler)
		}
		WriteError(w, r, err)
	}
}
