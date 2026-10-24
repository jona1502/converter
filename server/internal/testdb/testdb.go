// Package testdb legt für Tests frische PostgreSQL-Datenbanken im isolierten
// Teststack an (server/compose.test.yaml) und entfernt sie danach wieder.
//
// Schutz der Nutzdaten: Sowohl die Admin-Datenbank aus
// CONVERTER_TEST_DATABASE_URL als auch jede angelegte Datenbank müssen
// "test" im Namen tragen; andernfalls bricht der Helfer ab, ohne etwas
// anzulegen oder zu löschen.
package testdb

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/url"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// EnvURL ist die Variable mit der Admin-Verbindung des Teststacks.
const EnvURL = "CONVERTER_TEST_DATABASE_URL"

var safeName = regexp.MustCompile(`^[a-z0-9_]+$`)

// ValidateName lässt nur einfache Bezeichner mit "test" zu.
func ValidateName(name string) error {
	if !safeName.MatchString(name) || !strings.Contains(name, "test") {
		return errors.New("testdb: Datenbankname muss \"test\" enthalten und nur [a-z0-9_] nutzen")
	}
	return nil
}

// AdminURL liefert die geprüfte Admin-URL. Im Kurzmodus (-short) wird der
// Test übersprungen, sonst ist eine fehlende Variable ein Fehler: ein still
// übersprungener Datenbanktest wäre ein falsches Grün.
func AdminURL(t testing.TB) *url.URL {
	t.Helper()
	raw := os.Getenv(EnvURL)
	if raw == "" {
		if testing.Short() {
			t.Skip(EnvURL + " fehlt (-short)")
		}
		t.Fatal(EnvURL + " fehlt; Tests über server/compose.test.yaml starten")
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
		t.Fatal(EnvURL + " ist keine postgres-URL")
	}
	if err := ValidateName(strings.TrimPrefix(u.Path, "/")); err != nil {
		t.Fatal(err)
	}
	return u
}

// NewDatabase legt eine leere Datenbank converter_go_test_<zufall> an und
// entfernt sie am Testende. Rückgabe ist ihre Verbindungs-URL.
func NewDatabase(t testing.TB) string {
	t.Helper()
	admin := AdminURL(t)

	suffix := make([]byte, 6)
	if _, err := rand.Read(suffix); err != nil {
		t.Fatal(err)
	}
	name := "converter_go_test_" + hex.EncodeToString(suffix)
	if err := ValidateName(name); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := adminExec(ctx, admin, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize()); err != nil {
		t.Fatalf("testdb: Datenbank anlegen: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := adminExec(ctx, admin,
			"DROP DATABASE IF EXISTS "+pgx.Identifier{name}.Sanitize()+" WITH (FORCE)"); err != nil {
			t.Errorf("testdb: Datenbank %s entfernen: %v", name, err)
		}
	})

	target := *admin
	target.Path = "/" + name
	return target.String()
}

// NewPool legt eine Datenbank an und liefert einen Pool darauf; beides wird
// am Testende geschlossen bzw. entfernt.
func NewPool(t testing.TB) (*pgxpool.Pool, string) {
	t.Helper()
	dsn := NewDatabase(t)
	pool := Connect(t, dsn)
	return pool, dsn
}

// Connect öffnet einen weiteren Pool auf eine mit NewDatabase angelegte
// Datenbank; er wird vor dem Entfernen der Datenbank geschlossen.
func Connect(t testing.TB, dsn string) *pgxpool.Pool {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("testdb: Pool öffnen: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func adminExec(ctx context.Context, admin *url.URL, sql string) error {
	conn, err := pgx.Connect(ctx, admin.String())
	if err != nil {
		return err
	}
	defer conn.Close(context.WithoutCancel(ctx))
	_, err = conn.Exec(ctx, sql)
	return err
}
