package auth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"

	"miconverter/server/internal/apitypes"
	"miconverter/server/internal/config"
	"miconverter/server/internal/httpapi"
)

const testSecret = "test-secret-key-0123456789abcdefghijklmnop"

// fakeStore: Sitzungen im Speicher, nur für Tests.
type fakeStore struct {
	mu       sync.Mutex
	sessions map[TokenHash]StoredSession
	finds    int
	err      error
}

func (f *fakeStore) FindSession(_ context.Context, h TokenHash) (StoredSession, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.finds++
	if f.err != nil {
		return StoredSession{}, false, f.err
	}
	s, ok := f.sessions[h]
	if ok && !s.ExpiresAt.After(time.Now()) {
		return StoredSession{}, false, nil
	}
	return s, ok, nil
}

func (f *fakeStore) CreateSession(_ context.Context, h TokenHash) (StoredSession, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return StoredSession{}, f.err
	}
	s := StoredSession{ID: "6f0c1d5e-8a3b-4c2d-9e1f-0a1b2c3d4e5f", ExpiresAt: time.Now().Add(24 * time.Hour)}
	f.sessions[h] = s
	return s, nil
}

func newAuth(t *testing.T, env map[string]string) (*Auth, *fakeStore) {
	t.Helper()
	base := map[string]string{
		"CONVERTER_ENVIRONMENT":     "test",
		"CONVERTER_SECRET_KEY":      testSecret,
		"CONVERTER_ALLOWED_ORIGINS": "https://converter.example",
		"CONVERTER_TRUSTED_PROXIES": "172.30.218.10/32",
	}
	for k, v := range env {
		base[k] = v
	}
	cfg, err := config.Load(func(k string) (string, bool) { v, ok := base[k]; return v, ok })
	if err != nil {
		t.Fatal(err)
	}
	store := &fakeStore{sessions: map[TokenHash]StoredSession{}}
	return New(cfg, store), store
}

func apiError(t *testing.T, err error) *httpapi.Error {
	t.Helper()
	var e *httpapi.Error
	if !errors.As(err, &e) {
		t.Fatalf("erwartet *httpapi.Error, erhalten %v", err)
	}
	return e
}

func TestNewSessionTokenFormat(t *testing.T) {
	seen := map[string]bool{}
	for range 100 {
		tok, err := NewSessionToken()
		if err != nil {
			t.Fatal(err)
		}
		if !IsPlausibleToken(tok) || seen[tok] {
			t.Fatalf("Token %q ungültig oder doppelt", tok)
		}
		seen[tok] = true
	}
}

func TestSessionLifecycleAndCookie(t *testing.T) {
	a, _ := newAuth(t, map[string]string{"CONVERTER_SESSION_COOKIE_SECURE": "false"})
	ctx := context.Background()
	s, err := a.NewSession(ctx)
	if err != nil || !s.Created || s.Hash != HashToken(s.Token) {
		t.Fatalf("NewSession: %+v %v", s, err)
	}
	rec := httptest.NewRecorder()
	a.SetCookie(rec, s)
	header := rec.Header().Get("Set-Cookie")
	if header != "converter_session="+s.Token+"; HttpOnly; Max-Age=86400; Path=/; SameSite=strict" {
		t.Fatalf("Set-Cookie %q", header)
	}

	// Cookie zurückschicken: Go-Client-Parser muss es verstehen.
	resp := http.Response{Header: rec.Header()}
	cookies := resp.Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode || cookies[0].MaxAge != 86400 {
		t.Fatalf("Cookie: %+v", cookies)
	}
	r := httptest.NewRequest("GET", "/", nil)
	r.AddCookie(cookies[0])
	got, err := a.RequireSession(ctx, r)
	if err != nil || got.ID != s.ID || got.Created {
		t.Fatalf("RequireSession: %+v %v", got, err)
	}
	if a.CSRFToken(got) != CSRFToken(config.NewSecret(testSecret), s.Hash) {
		t.Fatal("CSRF-Token weicht ab")
	}
}

func TestSecureCookieUsesHostPrefix(t *testing.T) {
	a, _ := newAuth(t, nil)
	s, _ := a.NewSession(context.Background())
	rec := httptest.NewRecorder()
	a.SetCookie(rec, s)
	if h := rec.Header().Get("Set-Cookie"); !strings.HasPrefix(h, "__Host-converter_session=") || !strings.HasSuffix(h, "; Secure") || strings.Contains(h, "Domain") {
		t.Fatalf("Set-Cookie %q", h)
	}
	// Das unsichere Cookie zählt bei Secure nicht.
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("Cookie", "converter_session="+s.Token)
	if got, _ := a.OptionalSession(context.Background(), r); got != nil {
		t.Fatal("falscher Cookiename akzeptiert")
	}
}

func TestBrokenOrUnknownCookiesYieldNoSession(t *testing.T) {
	a, store := newAuth(t, map[string]string{"CONVERTER_SESSION_COOKIE_SECURE": "false"})
	for _, cookie := range []string{"", "converter_session=", "converter_session=kurz", "converter_session=" + strings.Repeat("x", 44), "converter_session=" + strings.Repeat("+", 43), "converter_session=" + strings.Repeat("x", 43)} {
		r := httptest.NewRequest("GET", "/", nil)
		if cookie != "" {
			r.Header.Set("Cookie", cookie)
		}
		s, err := a.OptionalSession(context.Background(), r)
		if s != nil || err != nil {
			t.Errorf("%q: %+v %v", cookie, s, err)
		}
		if _, err := a.RequireSession(context.Background(), r); apiError(t, err).Code != apitypes.CodeSessionRequired {
			t.Errorf("%q: kein 401", cookie)
		}
	}
	// Unplausible Tokens erreichen die Datenbank nicht; nur das plausible
	// unbekannte (je einmal über OptionalSession und RequireSession).
	if store.finds != 2 {
		t.Fatalf("FindSession %d-mal aufgerufen", store.finds)
	}
}

func TestExpiredSessionIsRejected(t *testing.T) {
	a, store := newAuth(t, map[string]string{"CONVERTER_SESSION_COOKIE_SECURE": "false"})
	s, _ := a.NewSession(context.Background())
	store.sessions[s.Hash] = StoredSession{ID: s.ID, ExpiresAt: time.Now().Add(-time.Second)}
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("Cookie", "converter_session="+s.Token)
	e := apiError(t, func() error { _, err := a.RequireSession(context.Background(), r); return err }())
	if e.Status != 401 || e.Message != "Gültige Sitzung erforderlich." {
		t.Fatalf("%+v", e)
	}
}

func TestStoreErrorIsPassedThrough(t *testing.T) {
	a, store := newAuth(t, map[string]string{"CONVERTER_SESSION_COOKIE_SECURE": "false"})
	s, _ := a.NewSession(context.Background())
	boom := errors.New("db down")
	store.err = boom
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("Cookie", "converter_session="+s.Token)
	if _, err := a.RequireWrite(context.Background(), r); !errors.Is(err, boom) {
		t.Fatalf("erwartet Persistenzfehler, erhalten %v", err)
	}
}

func writeRequest(token, csrf string, headers map[string]string) *http.Request {
	r := httptest.NewRequest("POST", "/api/v1/jobs", nil)
	if token != "" {
		r.Header.Set("Cookie", "converter_session="+token)
	}
	if csrf != "" {
		r.Header.Set(CSRFHeader, csrf)
	}
	for k, v := range headers {
		r.Header[http.CanonicalHeaderKey(k)] = []string{v}
	}
	return r
}

func TestRequireWriteOrderAndCases(t *testing.T) {
	a, _ := newAuth(t, map[string]string{"CONVERTER_SESSION_COOKIE_SECURE": "false"})
	s, _ := a.NewSession(context.Background())
	csrf := a.CSRFToken(s)
	origin := map[string]string{"Origin": "https://converter.example"}

	cases := []struct {
		name    string
		r       *http.Request
		status  int
		message string
	}{
		// Ohne Sitzung zählt 401 vor CSRF und Origin.
		{"ohne Sitzung", writeRequest("", "", map[string]string{"Origin": "https://evil.example"}), 401, "Gültige Sitzung erforderlich."},
		// CSRF vor Origin.
		{"CSRF fehlt", writeRequest(s.Token, "", map[string]string{"Origin": "https://evil.example"}), 403, "CSRF-Prüfung fehlgeschlagen."},
		{"CSRF leer", writeRequest(s.Token, "", map[string]string{"X-CSRF-Token": ""}), 403, "CSRF-Prüfung fehlgeschlagen."},
		{"CSRF falsch", writeRequest(s.Token, "falsch", origin), 403, "CSRF-Prüfung fehlgeschlagen."},
		{"CSRF anderer Sitzung", writeRequest(s.Token, CSRFToken(config.NewSecret(testSecret), HashToken(strings.Repeat("A", 43))), origin), 403, "CSRF-Prüfung fehlgeschlagen."},
		{"fremder Origin", writeRequest(s.Token, csrf, map[string]string{"Origin": "https://evil.example"}), 403, "Origin nicht erlaubt."},
		{"null-Origin", writeRequest(s.Token, csrf, map[string]string{"Origin": "null"}), 403, "Origin nicht erlaubt."},
		{"cross-site ohne Origin", writeRequest(s.Token, csrf, map[string]string{"Sec-Fetch-Site": "cross-site"}), 403, "Origin nicht erlaubt."},
		{"erlaubter Origin", writeRequest(s.Token, csrf, origin), 0, ""},
		{"Origin groß", writeRequest(s.Token, csrf, map[string]string{"Origin": "HTTPS://CONVERTER.EXAMPLE"}), 0, ""},
		{"same-origin ohne Origin", writeRequest(s.Token, csrf, map[string]string{"Sec-Fetch-Site": "same-origin"}), 0, ""},
		{"ohne Origin und Fetch-Metadata", writeRequest(s.Token, csrf, nil), 0, ""},
	}
	for _, tc := range cases {
		got, err := a.RequireWrite(context.Background(), tc.r)
		if tc.status == 0 {
			if err != nil || got.ID != s.ID {
				t.Errorf("%s: %v", tc.name, err)
			}
			continue
		}
		e := apiError(t, err)
		wantCode := apitypes.CodeCSRFFailed
		if tc.status == 401 {
			wantCode = apitypes.CodeSessionRequired
		}
		if e.Status != tc.status || e.Code != wantCode || e.Message != tc.message {
			t.Errorf("%s: %d %s %q", tc.name, e.Status, e.Code, e.Message)
		}
	}
}

func TestClientIPFromRequest(t *testing.T) {
	a, _ := newAuth(t, nil)
	cases := []struct {
		remote string
		xff    []string
		want   string
	}{
		// Gefälschtes XFF von nicht vertrauter Gegenstelle wird ignoriert.
		{"203.0.113.9:5555", []string{"1.2.3.4"}, "203.0.113.9"},
		{"172.30.218.10:5555", []string{"198.51.100.7"}, "198.51.100.7"},
		// Vom Client vorangestellte Einträge zählen nicht.
		{"172.30.218.10:5555", []string{"6.6.6.6, 198.51.100.7"}, "198.51.100.7"},
		// Mehrere Header-Zeilen: rechter Eintrag der letzten Zeile.
		{"172.30.218.10:5555", []string{"6.6.6.6", "198.51.100.7"}, "198.51.100.7"},
		{"172.30.218.10:5555", nil, "172.30.218.10"},
		{"[2001:db8::1]:5555", []string{"1.1.1.1"}, "2001:db8::1"},
	}
	for _, tc := range cases {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = tc.remote
		for _, v := range tc.xff {
			r.Header.Add("X-Forwarded-For", v)
		}
		if got := a.ClientIP(r); got != tc.want {
			t.Errorf("%s %v: %q, erwartet %q", tc.remote, tc.xff, got, tc.want)
		}
	}
	if ClientIP("", []string{"1.1.1.1"}, []netip.Prefix{netip.MustParsePrefix("0.0.0.0/0")}) != "unknown" {
		t.Error("leere Gegenstelle muss unknown ergeben")
	}
}

func TestUnquoteCookie(t *testing.T) {
	for in, want := range map[string]string{`"abc"`: "abc", `"a\"b"`: `a"b`, `"\101BC"`: "ABC", `"a`: `"a`, `""`: "", `x`: "x"} {
		if got := unquoteCookie(in); got != want {
			t.Errorf("%q → %q, erwartet %q", in, got, want)
		}
	}
}
