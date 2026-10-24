package store

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// DB ist die gemeinsame Teilmenge von *pgxpool.Pool, *pgx.Conn und pgx.Tx.
type DB interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// NewID erzeugt eine zufällige UUID (Version 4) wie Pythons uuid.uuid4().
func NewID() [16]byte {
	var id [16]byte
	_, _ = rand.Read(id[:]) // crypto/rand.Read scheitert nicht (Go ≥ 1.24)
	id[6] = id[6]&0x0f | 0x40
	id[8] = id[8]&0x3f | 0x80
	return id
}

// micros übergibt Dauern als Mikrosekunden (SQL: $n * interval '1 microsecond').
func micros(d time.Duration) int64 { return d.Microseconds() }

// SessionTouchInterval: Die gleitende Verlängerung wird höchstens einmal pro
// Minute geschrieben, damit Status-Polling nicht jede Anfrage schreibt.
const SessionTouchInterval = 60 * time.Second

// ErrSessionNotFound: kein gültiger (nicht abgelaufener) Eintrag zum Hash.
var ErrSessionNotFound = errors.New("store: Sitzung nicht gefunden")

// Session ist eine anonyme Sitzung; das Token selbst kennt nur der Cookie.
type Session struct {
	ID        [16]byte
	ExpiresAt time.Time
	Created   bool
}

// ValidateSessionTTL: Eine Sitzung muss mindestens so lange gelten wie ein
// Auftrag, sonst verlöre der Besitzer seine Aufträge vor deren Ablauf
// (Python: session_ttl_seconds must cover job_ttl_seconds).
func ValidateSessionTTL(sessionTTL, jobTTL time.Duration) error {
	if sessionTTL <= 0 || jobTTL <= 0 || sessionTTL < jobTTL {
		return errors.New("store: Sitzungsdauer muss mindestens die Auftragsdauer abdecken")
	}
	return nil
}

// CreateSession legt eine Sitzung mit tokenHash = SHA-256(Token) an
// (auth.create_session).
func CreateSession(ctx context.Context, db DB, tokenHash [32]byte, ttl time.Duration) (Session, error) {
	s := Session{ID: NewID(), Created: true}
	err := db.QueryRow(ctx, `
INSERT INTO sessions (id, token_hash, expires_at)
VALUES ($1, $2, now() + $3 * interval '1 microsecond')
RETURNING expires_at`, s.ID, tokenHash[:], micros(ttl)).Scan(&s.ExpiresAt)
	if err != nil {
		return Session{}, fmt.Errorf("store: Sitzung anlegen: %w", err)
	}
	return s, nil
}

// FindSession lädt die gültige Sitzung zum Hash und verlängert sie gleitend
// (last_seen_at = now(), expires_at = now() + ttl), sofern der letzte
// Kontakt mindestens SessionTouchInterval zurückliegt (auth.find_session).
// Abgelaufene Sitzungen werden nie verlängert. Eine Anweisung, daher atomar.
func FindSession(ctx context.Context, db DB, tokenHash [32]byte, ttl time.Duration) (Session, error) {
	var s Session
	err := db.QueryRow(ctx, `
WITH touched AS (
    UPDATE sessions
       SET last_seen_at = now(), expires_at = now() + $2 * interval '1 microsecond'
     WHERE token_hash = $1 AND expires_at > now()
       AND last_seen_at < now() - $3 * interval '1 microsecond'
 RETURNING id, expires_at)
SELECT id, expires_at FROM touched
UNION ALL
SELECT id, expires_at FROM sessions
 WHERE token_hash = $1 AND expires_at > now() AND NOT EXISTS (SELECT 1 FROM touched)`,
		tokenHash[:], micros(ttl), micros(SessionTouchInterval)).Scan(&s.ID, &s.ExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, ErrSessionNotFound
	}
	if err != nil {
		return Session{}, fmt.Errorf("store: Sitzung laden: %w", err)
	}
	return s, nil
}
