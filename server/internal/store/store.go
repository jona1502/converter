// Package store kapselt den PostgreSQL-Zugriff: Verbindungspool,
// Readiness-Prüfung, Migrationen und Cutover-Hilfen. Explizites SQL über
// pgx, keine ORM-Schicht.
package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrInvalidDSN meldet eine unbrauchbare Datenbank-URL. Der Text enthält die
// URL bewusst nicht, weil sie das Passwort tragen kann.
var ErrInvalidDSN = errors.New("store: Datenbank-URL ungültig")

// PoolOptions begrenzt Größe und Wartezeiten des Pools. Nullwerte werden
// durch die Defaults aus DefaultPoolOptions ersetzt.
type PoolOptions struct {
	MaxConns          int32
	MinConns          int32
	ConnectTimeout    time.Duration
	MaxConnLifetime   time.Duration
	MaxConnIdleTime   time.Duration
	HealthCheckPeriod time.Duration
	ApplicationName   string
}

// DefaultPoolOptions entspricht dem bisherigen Python-Pool (5 + 5 Überlauf,
// connect_timeout 5 s).
func DefaultPoolOptions() PoolOptions {
	return PoolOptions{
		MaxConns:          10,
		MinConns:          0,
		ConnectTimeout:    5 * time.Second,
		MaxConnLifetime:   30 * time.Minute,
		MaxConnIdleTime:   5 * time.Minute,
		HealthCheckPeriod: 30 * time.Second,
		ApplicationName:   "converter",
	}
}

func (o PoolOptions) withDefaults() PoolOptions {
	d := DefaultPoolOptions()
	if o.MaxConns <= 0 {
		o.MaxConns = d.MaxConns
	}
	if o.MinConns < 0 || o.MinConns > o.MaxConns {
		o.MinConns = 0
	}
	if o.ConnectTimeout <= 0 {
		o.ConnectTimeout = d.ConnectTimeout
	}
	if o.MaxConnLifetime <= 0 {
		o.MaxConnLifetime = d.MaxConnLifetime
	}
	if o.MaxConnIdleTime <= 0 {
		o.MaxConnIdleTime = d.MaxConnIdleTime
	}
	if o.HealthCheckPeriod <= 0 {
		o.HealthCheckPeriod = d.HealthCheckPeriod
	}
	if o.ApplicationName == "" {
		o.ApplicationName = d.ApplicationName
	}
	return o
}

// NormalizeDSN akzeptiert die bisherigen SQLAlchemy-URLs
// (postgresql+psycopg://…) und liefert eine URL, die pgx versteht.
func NormalizeDSN(dsn string) (string, error) {
	dsn = strings.TrimSpace(dsn)
	if dsn == "" {
		return "", ErrInvalidDSN
	}
	scheme, rest, ok := strings.Cut(dsn, "://")
	if !ok {
		// Schlüssel-Wert-Form (host=… dbname=…) reicht pgx unverändert durch.
		if strings.Contains(dsn, "=") {
			return dsn, nil
		}
		return "", ErrInvalidDSN
	}
	switch strings.ToLower(scheme) {
	case "postgres", "postgresql", "postgresql+psycopg", "postgres+psycopg":
		return "postgresql://" + rest, nil
	default:
		return "", ErrInvalidDSN
	}
}

// Open erzeugt einen Pool. Verbindungen entstehen erst bei Bedarf; ob die
// Datenbank erreichbar ist, prüft Ping.
func Open(ctx context.Context, dsn string, opts PoolOptions) (*pgxpool.Pool, error) {
	normalized, err := NormalizeDSN(dsn)
	if err != nil {
		return nil, err
	}
	cfg, err := pgxpool.ParseConfig(normalized)
	if err != nil {
		// Parserfehler können Teile der URL zitieren.
		return nil, ErrInvalidDSN
	}
	opts = opts.withDefaults()
	cfg.MaxConns = opts.MaxConns
	cfg.MinConns = opts.MinConns
	cfg.MaxConnLifetime = opts.MaxConnLifetime
	cfg.MaxConnLifetimeJitter = opts.MaxConnLifetime / 10
	cfg.MaxConnIdleTime = opts.MaxConnIdleTime
	cfg.HealthCheckPeriod = opts.HealthCheckPeriod
	cfg.ConnConfig.ConnectTimeout = opts.ConnectTimeout
	if cfg.ConnConfig.RuntimeParams == nil {
		cfg.ConnConfig.RuntimeParams = map[string]string{}
	}
	if _, set := cfg.ConnConfig.RuntimeParams["application_name"]; !set {
		cfg.ConnConfig.RuntimeParams["application_name"] = opts.ApplicationName
	}
	// Alle Zeitstempel in UTC, unabhängig von der Serverkonfiguration.
	cfg.ConnConfig.RuntimeParams["timezone"] = "UTC"

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("store: Pool anlegen: %w", err)
	}
	return pool, nil
}

// PingTimeout begrenzt die Readiness-Prüfung, falls der Aufrufer keinen
// eigenen Wert vorgibt.
const PingTimeout = 2 * time.Second

// Ping prüft für Readiness, ob eine Verbindung aufgebaut und eine Abfrage
// beantwortet werden kann; höchstens timeout lang (≤ 0: PingTimeout).
func Ping(ctx context.Context, pool *pgxpool.Pool, timeout time.Duration) error {
	if timeout <= 0 {
		timeout = PingTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var one int
	if err := pool.QueryRow(ctx, "SELECT 1").Scan(&one); err != nil {
		return fmt.Errorf("store: Datenbank nicht bereit: %w", err)
	}
	if one != 1 {
		return errors.New("store: Datenbank nicht bereit: unerwartete Antwort")
	}
	return nil
}
