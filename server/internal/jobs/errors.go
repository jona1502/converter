// Package jobs enthält die Auftragsannahme (Reservierung, Finalisierung,
// Idempotenz) sowie reine Hilfen für Namen, Signaturen und Fingerabdruck.
// Portierung von app/jobs/{acceptance,admission,naming,signatures}.py.
package jobs

import (
	"fmt"
	"net/http"
)

// Error ist ein fachlicher Fehler mit stabilem API-Code, HTTP-Status und
// optionalem Retry-After (Sekunden, 0 = ohne Header).
type Error struct {
	Code       string
	Status     int
	RetryAfter int
	Message    string
}

func (e *Error) Error() string { return fmt.Sprintf("jobs: %s (%s)", e.Message, e.Code) }

// Is vergleicht nur den Code, damit errors.Is mit den Werten unten greift.
func (e *Error) Is(target error) bool {
	t, ok := target.(*Error)
	return ok && t.Code == e.Code
}

var (
	ErrSessionJobLimit = &Error{"session-job-limit", http.StatusTooManyRequests, 2, "Zu viele aktive Aufträge."}
	ErrServerBusy      = &Error{"server-busy", http.StatusServiceUnavailable, 5, "Annahme ausgelastet."}
	ErrStorageFull     = &Error{"storage-full", http.StatusServiceUnavailable, 60, "Speicherbudget erschöpft."}
	// ErrReservationGone: Cleanup hat die abgelaufene Upload-Reservierung
	// bereits entfernt.
	ErrReservationGone     = &Error{"service-unavailable", http.StatusServiceUnavailable, 0, "Upload-Reservierung abgelaufen."}
	ErrIdempotencyConflict = &Error{"idempotency-conflict", http.StatusConflict, 0, "Idempotency-Key mit anderer Anfrage."}
)
