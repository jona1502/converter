// Package auth: anonyme Sitzung, CSRF, Origin-Prüfung und Client-IP hinter
// dem Proxy (Vertrag §3, §6). Reine Logik ohne Datenbank; die Persistenz
// kommt über das Interface Store aus internal/store.
//
// Kodierungen und Regeln entsprechen backend/app/core/security.py,
// backend/app/api/auth.py und backend/app/core/rate_limits.py; die
// Golden-Tests in testdata/golden.json stammen aus dem Python-Code.
package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"miconverter/server/internal/apitypes"
	"miconverter/server/internal/config"
	"miconverter/server/internal/httpapi"
)

const (
	// SessionTokenBytes: Zufallsbytes je Sitzungstoken.
	SessionTokenBytes = 32
	// TokenLength: Länge von base64url(32 Bytes) ohne Auffüllung.
	TokenLength = 43
	// CSRFHeader: Header schreibender Anfragen.
	CSRFHeader = "X-CSRF-Token"

	cookieNameSecure   = "__Host-converter_session"
	cookieNameInsecure = "converter_session"
)

// TokenHash ist SHA-256(Token); nur dieser Wert steht in der Datenbank.
type TokenHash [sha256.Size]byte

// NewSessionToken erzeugt ein Token wie secrets.token_urlsafe(32):
// 32 Zufallsbytes, base64url ohne "=".
func NewSessionToken() (string, error) {
	b := make([]byte, SessionTokenBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return encodeToken(b), nil
}

func encodeToken(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// IsPlausibleToken: genau 43 Zeichen aus [A-Za-z0-9_-]; alles andere ist
// sicher kein ausgegebenes Token und erreicht die Datenbank nicht.
func IsPlausibleToken(token string) bool {
	if len(token) != TokenLength {
		return false
	}
	for i := range len(token) {
		c := token[i]
		if !(c == '-' || c == '_' || (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
			return false
		}
	}
	return true
}

// HashToken liefert SHA-256 über die ASCII-Bytes des Tokens.
func HashToken(token string) TokenHash { return sha256.Sum256([]byte(token)) }

// CSRFToken = base64url(HMAC-SHA256(UTF-8(secret), "csrf:" + hex(hash)))
// ohne "="-Auffüllung. Der Hash geht als kleingeschriebener Hex-Text ein.
func CSRFToken(secret config.Secret, hash TokenHash) string {
	mac := hmac.New(sha256.New, []byte(secret.Reveal()))
	mac.Write([]byte("csrf:"))
	mac.Write([]byte(hex.EncodeToString(hash[:])))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// CSRFMatches vergleicht konstantzeitig; ein fehlender Header (ok=false)
// passt nie.
func CSRFMatches(expected, given string, ok bool) bool {
	if !ok {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(expected), []byte(given)) == 1
}

// CookieName: "__Host-converter_session" mit Secure, sonst für lokales HTTP
// "converter_session" (__Host- verlangt Secure).
func CookieName(secure bool) string {
	if secure {
		return cookieNameSecure
	}
	return cookieNameInsecure
}

// SetCookieValue erzeugt den Set-Cookie-Wert byte-gleich zu Starlette
// (Attribute alphabetisch, SameSite=strict). maxAge in Sekunden.
func SetCookieValue(secure bool, token string, maxAge int) string {
	var b strings.Builder
	b.WriteString(CookieName(secure))
	b.WriteByte('=')
	b.WriteString(token)
	b.WriteString("; HttpOnly; Max-Age=")
	b.WriteString(strconv.Itoa(maxAge))
	b.WriteString("; Path=/; SameSite=strict")
	if secure {
		b.WriteString("; Secure")
	}
	return b.String()
}

// CookieValue liest ein Cookie wie Starlettes cookie_parser: Teile an ";"
// trennen, Name/Wert trimmen, Anführungszeichen entfernen, bei mehrfachem
// Namen gewinnt der letzte. ok=false, wenn das Cookie fehlt.
func CookieValue(r *http.Request, name string) (value string, ok bool) {
	for _, header := range r.Header.Values("Cookie") {
		for chunk := range strings.SplitSeq(header, ";") {
			key, val, found := strings.Cut(chunk, "=")
			if !found {
				key, val = "", chunk
			}
			key, val = strings.TrimSpace(key), strings.TrimSpace(val)
			if key == name {
				value, ok = unquoteCookie(val), true
			}
		}
	}
	return value, ok
}

// unquoteCookie wie http.cookies._unquote: "…" entfernen, \x und \ooo auflösen.
func unquoteCookie(v string) string {
	if len(v) < 2 || v[0] != '"' || v[len(v)-1] != '"' {
		return v
	}
	v = v[1 : len(v)-1]
	var b strings.Builder
	for i := 0; i < len(v); i++ {
		if v[i] != '\\' || i+1 >= len(v) {
			b.WriteByte(v[i])
			continue
		}
		if i+3 < len(v) && v[i+1] >= '0' && v[i+1] <= '3' && isOctal(v[i+2]) && isOctal(v[i+3]) {
			n, _ := strconv.ParseUint(v[i+1:i+4], 8, 8)
			b.WriteByte(byte(n))
			i += 3
			continue
		}
		b.WriteByte(v[i+1])
		i++
	}
	return b.String()
}

func isOctal(c byte) bool { return c >= '0' && c <= '7' }

// OriginAllowed: Ist Origin gesendet, muss er (kleingeschrieben) exakt in
// allowed stehen; ohne Origin darf Sec-Fetch-Site nicht "cross-site" sein.
// allowed ist bereits normalisiert (config.AllowedOrigins).
func OriginAllowed(r *http.Request, allowed []string) bool {
	if values := r.Header.Values("Origin"); len(values) > 0 {
		origin := strings.ToLower(values[0])
		for _, a := range allowed {
			if origin == a {
				return true
			}
		}
		return false
	}
	return strings.ToLower(r.Header.Get("Sec-Fetch-Site")) != "cross-site"
}

// ClientIP ermittelt die Client-Adresse wie rate_limits.client_ip: Nur wenn
// die direkte Gegenstelle in trusted liegt, wird X-Forwarded-For von rechts
// nach links gelesen, solange die Einträge vertrauten Proxies gehören; der
// erste nicht vertraute Eintrag ist der Client. Ein ungültiger Eintrag
// beendet die Suche. Ergebnis in kanonischer Schreibweise.
func ClientIP(remoteAddr string, forwardedFor []string, trusted []netip.Prefix) string {
	peer, ok := parsePeer(remoteAddr)
	if !ok {
		return peerFallback(remoteAddr)
	}
	isTrusted := func(a netip.Addr) bool {
		for _, p := range trusted {
			if p.Contains(a) {
				return true
			}
		}
		return false
	}
	addr := peer
	if !isTrusted(addr) {
		return addr.String()
	}
	// Mehrere Header-Zeilen gelten als eine kommagetrennte Liste.
	chain := strings.Split(strings.Join(forwardedFor, ","), ",")
	for i := len(chain) - 1; i >= 0; i-- {
		candidate, err := netip.ParseAddr(strings.TrimSpace(chain[i]))
		if err != nil {
			break
		}
		addr = candidate
		if !isTrusted(addr) {
			break
		}
	}
	return addr.String()
}

func parsePeer(remoteAddr string) (netip.Addr, bool) {
	if ap, err := netip.ParseAddrPort(remoteAddr); err == nil {
		return ap.Addr(), true
	}
	if a, err := netip.ParseAddr(remoteAddr); err == nil {
		return a, true
	}
	return netip.Addr{}, false
}

func peerFallback(remoteAddr string) string {
	if remoteAddr == "" {
		return "unknown"
	}
	if host, _, err := net.SplitHostPort(remoteAddr); err == nil {
		return host
	}
	return remoteAddr
}

// RateLimitKey erzeugt den Valkey-Schlüssel wie rate_limits._key:
// "converter:rate:" + kind + ":" + hex(SHA-256(UTF-8(identity))).
func RateLimitKey(kind, identity string) string {
	sum := sha256.Sum256([]byte(identity))
	return "converter:rate:" + kind + ":" + hex.EncodeToString(sum[:])
}

// --- Sitzungen mit Persistenz ------------------------------------------------

// StoredSession: von der Persistenz gelieferte Sitzung.
type StoredSession struct {
	ID        string // UUID
	ExpiresAt time.Time
}

// Store ist die Sitzungs-Persistenz (internal/store).
type Store interface {
	// FindSession lädt eine nicht abgelaufene Sitzung und verlängert sie
	// gleitend; found=false bei unbekannt oder abgelaufen.
	FindSession(ctx context.Context, hash TokenHash) (s StoredSession, found bool, err error)
	// CreateSession legt eine Sitzung mit Ablauf jetzt + Sitzungsdauer an.
	CreateSession(ctx context.Context, hash TokenHash) (StoredSession, error)
}

// Session ist die Sitzung der laufenden Anfrage.
type Session struct {
	ID        string
	Token     string
	Hash      TokenHash
	ExpiresAt time.Time
	Created   bool
}

// Auth bündelt Konfiguration und Persistenz.
type Auth struct {
	secret  config.Secret
	secure  bool
	origins []string
	proxies []netip.Prefix
	ttl     time.Duration
	store   Store
}

// New erzeugt Auth aus der Konfiguration.
func New(cfg *config.Config, store Store) *Auth {
	return &Auth{
		secret:  cfg.EffectiveSecretKey(),
		secure:  cfg.SessionCookieSecure,
		origins: cfg.AllowedOrigins,
		proxies: cfg.TrustedProxies,
		ttl:     cfg.SessionTTL,
		store:   store,
	}
}

// Fehler im Vertragsformat (Texte wie im Python-Backend).
func errSessionRequired() *httpapi.Error {
	return httpapi.NewError(http.StatusUnauthorized, apitypes.CodeSessionRequired, "Gültige Sitzung erforderlich.")
}

func errCSRF() *httpapi.Error {
	return httpapi.NewError(http.StatusForbidden, apitypes.CodeCSRFFailed, "CSRF-Prüfung fehlgeschlagen.")
}

func errOrigin() *httpapi.Error {
	return httpapi.NewError(http.StatusForbidden, apitypes.CodeCSRFFailed, "Origin nicht erlaubt.")
}

// CookieName der konfigurierten Umgebung.
func (a *Auth) CookieName() string { return CookieName(a.secure) }

// CSRFToken der Sitzung.
func (a *Auth) CSRFToken(s *Session) string { return CSRFToken(a.secret, s.Hash) }

// ClientIP der Anfrage nach TRUSTED_PROXIES.
func (a *Auth) ClientIP(r *http.Request) string {
	return ClientIP(r.RemoteAddr, r.Header.Values("X-Forwarded-For"), a.proxies)
}

// OptionalSession liefert die gültige Sitzung aus dem Cookie oder nil.
// Fehlende, leere, unplausible, unbekannte und abgelaufene Tokens ergeben
// nil ohne Fehler; err nur bei Persistenzfehlern.
func (a *Auth) OptionalSession(ctx context.Context, r *http.Request) (*Session, error) {
	token, ok := CookieValue(r, a.CookieName())
	if !ok || token == "" || !IsPlausibleToken(token) {
		return nil, nil
	}
	hash := HashToken(token)
	stored, found, err := a.store.FindSession(ctx, hash)
	if err != nil || !found {
		return nil, err
	}
	return &Session{ID: stored.ID, Token: token, Hash: hash, ExpiresAt: stored.ExpiresAt}, nil
}

// RequireSession: wie OptionalSession, ohne Sitzung 401 session-required.
func (a *Auth) RequireSession(ctx context.Context, r *http.Request) (*Session, error) {
	s, err := a.OptionalSession(ctx, r)
	if err != nil {
		return nil, err
	}
	if s == nil {
		return nil, errSessionRequired()
	}
	return s, nil
}

// RequireWrite schützt POST/DELETE in der Reihenfolge des Vertrags:
// Sitzung (401), X-CSRF-Token (403), Origin bzw. Sec-Fetch-Site (403).
func (a *Auth) RequireWrite(ctx context.Context, r *http.Request) (*Session, error) {
	s, err := a.RequireSession(ctx, r)
	if err != nil {
		return nil, err
	}
	given, ok := firstHeader(r, CSRFHeader)
	if !CSRFMatches(a.CSRFToken(s), given, ok) {
		return nil, errCSRF()
	}
	if !OriginAllowed(r, a.origins) {
		return nil, errOrigin()
	}
	return s, nil
}

func firstHeader(r *http.Request, name string) (string, bool) {
	values := r.Header.Values(name)
	if len(values) == 0 {
		return "", false
	}
	return values[0], true
}

// NewSession legt eine neue Sitzung an.
func (a *Auth) NewSession(ctx context.Context) (*Session, error) {
	token, err := NewSessionToken()
	if err != nil {
		return nil, err
	}
	hash := HashToken(token)
	stored, err := a.store.CreateSession(ctx, hash)
	if err != nil {
		return nil, err
	}
	return &Session{ID: stored.ID, Token: token, Hash: hash, ExpiresAt: stored.ExpiresAt, Created: true}, nil
}

// SetCookie setzt das Sitzungscookie (Max-Age = Sitzungsdauer); wie in
// Python bei jedem GET /session erneut.
func (a *Auth) SetCookie(w http.ResponseWriter, s *Session) {
	w.Header().Add("Set-Cookie", SetCookieValue(a.secure, s.Token, int(a.ttl/time.Second)))
}
