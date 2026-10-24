package store_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"miconverter/server/internal/store"
	"miconverter/server/internal/testdb"
)

func TestNormalizeDSN(t *testing.T) {
	cases := map[string]string{
		"postgresql+psycopg://u:p@db:5432/x": "postgresql://u:p@db:5432/x",
		"postgres+psycopg://u:p@db/x":        "postgresql://u:p@db/x",
		"postgresql://u:p@db/x":              "postgresql://u:p@db/x",
		"postgres://u:p@db/x?sslmode=off":    "postgresql://u:p@db/x?sslmode=off",
		"host=db dbname=x":                   "host=db dbname=x",
	}
	for in, want := range cases {
		got, err := store.NormalizeDSN(in)
		if err != nil || got != want {
			t.Errorf("NormalizeDSN(%q) = %q, %v", in, got, err)
		}
	}
	for _, bad := range []string{"", "mysql://u:geheim@db/x", "postgresql+asyncpg://u:geheim@db/x", "kein-dsn"} {
		_, err := store.NormalizeDSN(bad)
		if !errors.Is(err, store.ErrInvalidDSN) {
			t.Errorf("NormalizeDSN(%q) Fehler = %v", bad, err)
		}
	}
}

func TestOpenErrorsDoNotLeakPassword(t *testing.T) {
	ctx := t.Context()
	for _, dsn := range []string{
		"mysql://u:geheim@db/x",
		"postgresql://u:geheim@db:notaport/x",
	} {
		_, err := store.Open(ctx, dsn, store.PoolOptions{})
		if err == nil {
			t.Fatalf("Open(%q) ohne Fehler", dsn)
		}
		if strings.Contains(err.Error(), "geheim") {
			t.Fatalf("Fehler enthält Passwort: %v", err)
		}
	}
}

func TestOpenAndPing(t *testing.T) {
	dsn := testdb.NewDatabase(t)
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	pool, err := store.Open(ctx, strings.Replace(dsn, "postgres://", "postgresql+psycopg://", 1),
		store.PoolOptions{MaxConns: 2})
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if got := pool.Config().MaxConns; got != 2 {
		t.Fatalf("MaxConns = %d", got)
	}
	if err := store.Ping(ctx, pool, time.Second); err != nil {
		t.Fatal(err)
	}
	var tz string
	if err := pool.QueryRow(ctx, "SHOW timezone").Scan(&tz); err != nil || tz != "UTC" {
		t.Fatalf("timezone = %q, %v", tz, err)
	}
}

func TestPingFailsWithinTimeout(t *testing.T) {
	ctx := t.Context()
	// Nicht routbare Adresse (TEST-NET-1): Verbindung kann nie gelingen.
	pool, err := store.Open(ctx, "postgresql://u:geheim@192.0.2.1:5432/x_test?connect_timeout=30",
		store.PoolOptions{ConnectTimeout: 10 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	start := time.Now()
	err = store.Ping(ctx, pool, 300*time.Millisecond)
	if err == nil {
		t.Fatal("Ping ohne Fehler")
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("Ping dauerte %v", elapsed)
	}
	if strings.Contains(err.Error(), "geheim") {
		t.Fatalf("Fehler enthält Passwort: %v", err)
	}
}
