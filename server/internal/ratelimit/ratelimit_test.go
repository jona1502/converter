package ratelimit_test

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"miconverter/server/internal/ratelimit"
)

// newLimiter verbindet mit dem isolierten Test-Valkey (DB 15) und nutzt ein
// zufälliges Testpräfix; am Ende werden nur dessen Schlüssel gelöscht.
func newLimiter(t *testing.T) (*ratelimit.Limiter, *redis.Client, string) {
	t.Helper()
	url := os.Getenv("CONVERTER_TEST_REDIS_URL")
	if url == "" {
		if testing.Short() {
			t.Skip("CONVERTER_TEST_REDIS_URL fehlt (-short)")
		}
		t.Fatal("CONVERTER_TEST_REDIS_URL fehlt; Tests über server/compose.test.yaml starten")
	}
	client, err := ratelimit.NewClient(url)
	if err != nil {
		t.Fatal(err)
	}
	if client.Options().DB != 15 {
		t.Fatalf("Test-Valkey muss DB 15 nutzen, nicht %d", client.Options().DB)
	}
	var suffix [6]byte
	_, _ = rand.Read(suffix[:])
	prefix := "converter:test:" + hex.EncodeToString(suffix[:]) + ":"
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		iter := client.Scan(ctx, 0, prefix+"*", 100).Iterator()
		for iter.Next(ctx) {
			client.Del(ctx, iter.Val())
		}
		_ = client.Close()
	})
	return ratelimit.NewWithPrefix(client, prefix), client, prefix
}

func testCtx(t *testing.T) context.Context {
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func TestKeyMatchesPython(t *testing.T) {
	l := ratelimit.New(nil)
	sum := sha256.Sum256([]byte("203.0.113.7"))
	want := "converter:rate:create-ip:" + hex.EncodeToString(sum[:])
	if got := l.Key("create-ip", "203.0.113.7"); got != want {
		t.Fatalf("Key = %s", got)
	}
}

func TestNewClientDisablesCommandRetries(t *testing.T) {
	// Die Konstruktion verbindet nicht. Entscheidend ist die bereits von
	// go-redis normalisierte Option: Eingabe 0 würde drei Retries aktivieren.
	client, err := ratelimit.NewClient("redis://127.0.0.1:1/15")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	if got := client.Options().MaxRetries; got != 0 {
		t.Fatalf("effektive Command-Retries = %d, erwartet 0", got)
	}
}

func TestWindowLimit(t *testing.T) {
	l, client, prefix := newLimiter(t)
	ctx := testCtx(t)
	lim := ratelimit.Limit{Kind: "create-session", Identity: "s1", PerMinute: 3}
	for i := range 3 {
		if err := l.Check(ctx, lim); err != nil {
			t.Fatalf("%d: %v", i, err)
		}
	}
	if err := l.Check(ctx, lim); !errors.Is(err, ratelimit.ErrLimited) {
		t.Fatalf("viertes Ereignis: %v", err)
	}
	key := l.Key("create-session", "s1")
	if !strings.HasPrefix(key, prefix) {
		t.Fatal("Präfix fehlt")
	}
	if n, _ := client.ZCard(ctx, key).Result(); n != 3 {
		t.Fatalf("ZCARD = %d", n)
	}
	if ttl, _ := client.PTTL(ctx, key).Result(); ttl <= 0 || ttl > 61*time.Second {
		t.Fatalf("PTTL = %v", ttl)
	}
	// Andere Identität ist unabhängig.
	if err := l.Check(ctx, ratelimit.Limit{Kind: "create-session", Identity: "s2", PerMinute: 3}); err != nil {
		t.Fatal(err)
	}
}

func TestMultipleLimitsAreAllOrNothing(t *testing.T) {
	l, client, _ := newLimiter(t)
	ctx := testCtx(t)
	session := ratelimit.Limit{Kind: "create-session", Identity: "s", PerMinute: 5}
	ip := ratelimit.Limit{Kind: "create-ip", Identity: "198.51.100.1", PerMinute: 1}
	if err := l.Check(ctx, session, ip); err != nil {
		t.Fatal(err)
	}
	if err := l.Check(ctx, session, ip); !errors.Is(err, ratelimit.ErrLimited) {
		t.Fatalf("IP-Grenze: %v", err)
	}
	// Abgelehnte Prüfung zählt in keinem Fenster.
	if n, _ := client.ZCard(ctx, l.Key("create-session", "s")).Result(); n != 1 {
		t.Fatalf("Sitzungsfenster = %d", n)
	}
}

func TestConcurrentChecksNeverExceedLimit(t *testing.T) {
	l, _, _ := newLimiter(t)
	ctx := testCtx(t)
	var ok atomic.Int32
	var wg sync.WaitGroup
	for range 50 {
		wg.Go(func() {
			err := l.Check(ctx, ratelimit.Limit{Kind: "create-ip", Identity: "x", PerMinute: 10})
			switch {
			case err == nil:
				ok.Add(1)
			case !errors.Is(err, ratelimit.ErrLimited):
				t.Error(err)
			}
		})
	}
	wg.Wait()
	if ok.Load() != 10 {
		t.Fatalf("%d statt 10 zugelassen", ok.Load())
	}
}

func TestIdempotencyLockSerializesFirstRequests(t *testing.T) {
	l, client, _ := newLimiter(t)
	ctx := testCtx(t)
	var held atomic.Int32
	releases := make(chan ratelimit.Release, 20)
	var wg sync.WaitGroup
	for range 20 {
		wg.Go(func() {
			rel, err := l.IdempotencyLock(ctx, "sess", "key-0123456789abcdef", 600*time.Second)
			switch {
			case err == nil:
				held.Add(1)
				releases <- rel
			case !errors.Is(err, ratelimit.ErrBusy):
				t.Error(err)
			}
		})
	}
	wg.Wait()
	close(releases)
	if held.Load() != 1 {
		t.Fatalf("%d gleichzeitige Halter", held.Load())
	}
	key := l.Key("idempotency-lock", "sess:key-0123456789abcdef")
	if ttl, _ := client.TTL(ctx, key).Result(); ttl < 600*time.Second || ttl > 610*time.Second {
		t.Fatalf("TTL = %v (erwartet upload_max + 10 s)", ttl)
	}
	for rel := range releases {
		rel()
		rel() // mehrfach harmlos
	}
	if n, _ := client.Exists(ctx, key).Result(); n != 0 {
		t.Fatal("Sperre nicht freigegeben")
	}
	rel, err := l.IdempotencyLock(ctx, "sess", "key-0123456789abcdef", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	rel()
}

func TestReleaseDoesNotDeleteForeignLock(t *testing.T) {
	l, client, _ := newLimiter(t)
	ctx := testCtx(t)
	rel, err := l.Acquire(ctx, "replay-lock", "s", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	key := l.Key("replay-lock", "s")
	// Sperre ist abgelaufen und neu vergeben worden.
	if err := client.Set(ctx, key, "fremder-token", time.Minute).Err(); err != nil {
		t.Fatal(err)
	}
	rel()
	if v, _ := client.Get(ctx, key).Result(); v != "fremder-token" {
		t.Fatal("fremde Sperre gelöscht")
	}
}

func TestReplayGuard(t *testing.T) {
	l, _, _ := newLimiter(t)
	ctx := testCtx(t)
	rel, err := l.ReplayGuard(ctx, "s", 30, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := l.ReplayGuard(ctx, "s", 30, time.Minute); !errors.Is(err, ratelimit.ErrBusy) {
		t.Fatalf("zweiter gleichzeitiger Replay: %v", err)
	}
	rel()
	if _, err := l.ReplayGuard(ctx, "s", 2, time.Minute); !errors.Is(err, ratelimit.ErrLimited) {
		// Bisher 2 gezählte Replays (auch der an der Sperre gescheiterte
		// zählt, wie in Python).
		t.Fatalf("Replay-Limit: %v", err)
	}
}

func TestFailClosed(t *testing.T) {
	ctx := testCtx(t)
	if err := (*ratelimit.Limiter)(nil).Check(ctx); !errors.Is(err, ratelimit.ErrUnavailable) {
		t.Fatalf("nil: %v", err)
	}
	if err := ratelimit.New(nil).Check(ctx, ratelimit.Limit{Kind: "k", Identity: "i", PerMinute: 1}); !errors.Is(err, ratelimit.ErrUnavailable) {
		t.Fatalf("ohne Client: %v", err)
	}
	client, err := ratelimit.NewClient("redis://:geheim@127.0.0.1:1/15")
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	l := ratelimit.New(client)
	err = l.Check(ctx, ratelimit.Limit{Kind: "k", Identity: "i", PerMinute: 1})
	if !errors.Is(err, ratelimit.ErrUnavailable) {
		t.Fatalf("Check: %v", err)
	}
	if strings.Contains(err.Error(), "geheim") {
		t.Fatalf("Passwort im Fehler: %v", err)
	}
	if _, err := l.Acquire(ctx, "k", "i", time.Minute); !errors.Is(err, ratelimit.ErrUnavailable) {
		t.Fatalf("Acquire: %v", err)
	}
	if _, err := ratelimit.NewClient("http://x"); err == nil {
		t.Fatal("ungültige URL akzeptiert")
	}
}
