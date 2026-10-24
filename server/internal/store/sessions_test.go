package store_test

import (
	"crypto/sha256"
	"errors"
	"testing"
	"time"

	"miconverter/server/internal/store"
	"miconverter/server/internal/testdb"
	"miconverter/server/migrations"
)

func TestSessionsCreateFindAndSlide(t *testing.T) {
	ctx := testContext(t)
	pool, _ := testdb.NewPool(t)
	if _, err := store.Migrate(ctx, pool, migrations.FS); err != nil {
		t.Fatal(err)
	}
	const ttl = 24 * time.Hour
	hash := sha256.Sum256([]byte("token-a"))

	created, err := store.CreateSession(ctx, pool, hash, ttl)
	if err != nil {
		t.Fatal(err)
	}
	if !created.Created || time.Until(created.ExpiresAt) < ttl-time.Minute {
		t.Fatalf("Sitzung = %+v", created)
	}
	if _, err := store.CreateSession(ctx, pool, hash, ttl); err == nil {
		t.Fatal("doppelter Tokenhash akzeptiert")
	}

	found, err := store.FindSession(ctx, pool, hash, ttl)
	if err != nil || found.ID != created.ID || found.Created {
		t.Fatalf("FindSession = %+v, %v", found, err)
	}
	// Innerhalb des Intervalls wird nicht geschrieben.
	if !found.ExpiresAt.Equal(created.ExpiresAt) {
		t.Fatalf("Ablauf ohne Touch verändert: %v → %v", created.ExpiresAt, found.ExpiresAt)
	}

	// Letzter Kontakt vor 2 min, Ablauf in 10 min → gleitend verlängert.
	if _, err := pool.Exec(ctx, `UPDATE sessions SET last_seen_at = now() - interval '2 minutes',
		expires_at = now() + interval '10 minutes' WHERE id = $1`, created.ID); err != nil {
		t.Fatal(err)
	}
	slid, err := store.FindSession(ctx, pool, hash, ttl)
	if err != nil {
		t.Fatal(err)
	}
	if time.Until(slid.ExpiresAt) < ttl-time.Minute {
		t.Fatalf("nicht verlängert: %v", slid.ExpiresAt)
	}
	var fresh bool
	if err := pool.QueryRow(ctx, `SELECT now() - last_seen_at < interval '10 seconds' FROM sessions WHERE id = $1`,
		created.ID).Scan(&fresh); err != nil {
		t.Fatal(err)
	}
	if !fresh {
		t.Fatal("last_seen_at nicht aktualisiert")
	}

	// Abgelaufen: nicht gefunden und nicht wiederbelebt.
	if _, err := pool.Exec(ctx, `UPDATE sessions SET last_seen_at = now() - interval '2 days',
		expires_at = now() - interval '1 second' WHERE id = $1`, created.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.FindSession(ctx, pool, hash, ttl); !errors.Is(err, store.ErrSessionNotFound) {
		t.Fatalf("abgelaufene Sitzung: %v", err)
	}
	var stillExpired bool
	if err := pool.QueryRow(ctx, "SELECT expires_at < now() FROM sessions WHERE id = $1", created.ID).Scan(&stillExpired); err != nil || !stillExpired {
		t.Fatalf("abgelaufene Sitzung wurde verlängert (%v)", err)
	}

	if _, err := store.FindSession(ctx, pool, sha256.Sum256([]byte("unbekannt")), ttl); !errors.Is(err, store.ErrSessionNotFound) {
		t.Fatalf("unbekannter Hash: %v", err)
	}
}

func TestValidateSessionTTL(t *testing.T) {
	if err := store.ValidateSessionTTL(24*time.Hour, time.Hour); err != nil {
		t.Fatal(err)
	}
	if err := store.ValidateSessionTTL(time.Hour, time.Hour); err != nil {
		t.Fatal(err)
	}
	if err := store.ValidateSessionTTL(30*time.Minute, time.Hour); err == nil {
		t.Fatal("zu kurze Sitzung akzeptiert")
	}
}

func TestNewIDIsVersion4(t *testing.T) {
	seen := map[[16]byte]bool{}
	for range 100 {
		id := store.NewID()
		if id[6]>>4 != 4 || id[8]>>6 != 2 {
			t.Fatalf("keine UUIDv4: %x", id)
		}
		if seen[id] {
			t.Fatal("Duplikat")
		}
		seen[id] = true
	}
}
