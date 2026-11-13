// Package ratelimit bildet die prozessübergreifenden Grenzen aus
// app/core/rate_limits.py auf Valkey ab: gleitende 60-s-Fenster per
// Lua-Skript (atomar über alle Schlüssel einer Prüfung) und kurze
// Sperren (SET NX EX) für Idempotenz-Erstanfragen und Wiederholungs-Uploads.
// Schlüssel und Skripte sind identisch mit Python; Identitäten (IP,
// Sitzung) werden nur als SHA-256 gespeichert. Jeder Valkey-Fehler führt
// zu ErrUnavailable (fail-closed).
package ratelimit

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// KeyPrefix ist das Präfix aller Schlüssel (wie Python).
const KeyPrefix = "converter:rate:"

// Fehler mit fester API-Abbildung.
var (
	// ErrUnavailable: Valkey nicht erreichbar oder Fehler → 503 server-busy, Retry-After 5.
	ErrUnavailable = errors.New("ratelimit: Valkey nicht verfügbar")
	// ErrLimited: Fenster voll → 429 rate-limited, Retry-After 60.
	ErrLimited = errors.New("ratelimit: zu viele Anfragen")
	// ErrBusy: Sperre gehalten (gleicher Erst-Request oder zweiter
	// Wiederholungs-Upload) → 429 rate-limited, Retry-After 1.
	ErrBusy = errors.New("ratelimit: Vorgang läuft bereits")
)

// windowScript ist WINDOW_SCRIPT aus rate_limits.py, unverändert.
var windowScript = redis.NewScript(`
local now = redis.call('TIME')
local ms = now[1]*1000 + math.floor(now[2]/1000)
for i,key in ipairs(KEYS) do
  redis.call('ZREMRANGEBYSCORE',key,'-inf',ms-60000)
  if redis.call('ZCARD',key) >= tonumber(ARGV[i+1]) then return 0 end
end
for i,key in ipairs(KEYS) do
  redis.call('ZADD',key,ms,ARGV[1])
  redis.call('PEXPIRE',key,61000)
end
return 1
`)

// unlockScript ist UNLOCK_SCRIPT aus rate_limits.py: nur der eigene Token löscht.
var unlockScript = redis.NewScript(
	"if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0")

// Limit ist eine Fensterprüfung: höchstens PerMinute Ereignisse je Identity.
type Limit struct {
	Kind      string // z. B. "create-session", "create-ip", "replay", "new-session"
	Identity  string // Sitzungs-UUID (kanonisch klein) oder Client-IP
	PerMinute int
}

// Limiter prüft Grenzen gegen einen Valkey-Client.
type Limiter struct {
	client redis.UniversalClient
	prefix string
}

// New nutzt das Präfix converter:rate: wie Python.
func New(client redis.UniversalClient) *Limiter { return NewWithPrefix(client, KeyPrefix) }

// NewWithPrefix ist für Tests mit eigenem Schlüsselraum.
func NewWithPrefix(client redis.UniversalClient, prefix string) *Limiter {
	return &Limiter{client: client, prefix: prefix}
}

// NewClient öffnet einen Client mit kurzen Zeitgrenzen wie Python
// (socket_timeout=2, socket_connect_timeout=2). Fehler nennen die URL nicht.
func NewClient(url string) (*redis.Client, error) {
	opts, err := redis.ParseURL(url)
	if err != nil {
		return nil, errors.New("ratelimit: Valkey-URL ungültig")
	}
	opts.DialTimeout = 2 * time.Second
	opts.ReadTimeout = 2 * time.Second
	opts.WriteTimeout = 2 * time.Second
	opts.MaxRetries = -1
	return redis.NewClient(opts), nil
}

// Key wie rate_limits._key: Präfix + Art + ":" + sha256hex(Identität).
func (l *Limiter) Key(kind, identity string) string {
	sum := sha256.Sum256([]byte(identity))
	return l.prefix + kind + ":" + hex.EncodeToString(sum[:])
}

func randomToken() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:]) // wie uuid4().hex: 32 Hexzeichen
}

func unavailable(err error) error { return fmt.Errorf("%w: %w", ErrUnavailable, err) }

// Check zählt ein Ereignis in allen Fenstern, aber nur, wenn keines voll
// ist (alles oder nichts, atomar im Skript). Voll → ErrLimited.
func (l *Limiter) Check(ctx context.Context, limits ...Limit) error {
	if l == nil || l.client == nil {
		return ErrUnavailable
	}
	if len(limits) == 0 {
		return nil
	}
	keys := make([]string, len(limits))
	args := make([]any, 0, len(limits)+1)
	args = append(args, randomToken())
	for i, lim := range limits {
		if lim.PerMinute <= 0 {
			return errors.New("ratelimit: Grenze muss positiv sein")
		}
		keys[i] = l.Key(lim.Kind, lim.Identity)
		args = append(args, strconv.Itoa(lim.PerMinute))
	}
	accepted, err := windowScript.Run(ctx, l.client, keys, args...).Int()
	if err != nil {
		return unavailable(err)
	}
	if accepted != 1 {
		return ErrLimited
	}
	return nil
}

// Release gibt eine Sperre frei; mehrfacher Aufruf ist harmlos.
type Release func()

// Acquire setzt eine Sperre (SET NX EX ttl) wie submission_guard. Gehalten
// → ErrBusy. Die endliche TTL gibt die Sperre auch nach einem Absturz frei.
func (l *Limiter) Acquire(ctx context.Context, kind, identity string, ttl time.Duration) (Release, error) {
	if l == nil || l.client == nil {
		return nil, ErrUnavailable
	}
	key, token := l.Key(kind, identity), randomToken()
	acquired, err := l.client.SetNX(ctx, key, token, ttl).Result()
	if err != nil {
		return nil, unavailable(err)
	}
	if !acquired {
		return nil, ErrBusy
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			// Eigener Context: Freigabe auch nach Abbruch des Requests.
			ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
			defer cancel()
			_ = unlockScript.Run(ctx, l.client, []string{key}, token).Err()
		})
	}, nil
}

// LockTTL entspricht ex=upload_max_seconds + 10 in Python.
func LockTTL(uploadMax time.Duration) time.Duration { return uploadMax + 10*time.Second }

// IdempotencyLock serialisiert gleichzeitige Erst-Requests mit demselben
// Schlüssel (Kind "idempotency-lock", Identität "<session>:<key>").
func (l *Limiter) IdempotencyLock(ctx context.Context, sessionID, idempotencyKey string, uploadMax time.Duration) (Release, error) {
	return l.Acquire(ctx, "idempotency-lock", sessionID+":"+idempotencyKey, LockTTL(uploadMax))
}

// ReplayGuard wie replay_guard: Wiederholungslimit je Sitzung (ErrLimited)
// und höchstens ein gleichzeitiger Wiederholungs-Upload (ErrBusy).
func (l *Limiter) ReplayGuard(ctx context.Context, sessionID string, perMinute int, uploadMax time.Duration) (Release, error) {
	if err := l.Check(ctx, Limit{Kind: "replay", Identity: sessionID, PerMinute: perMinute}); err != nil {
		return nil, err
	}
	return l.Acquire(ctx, "replay-lock", sessionID, LockTTL(uploadMax))
}
