package auth

import (
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http/httptest"
	"net/netip"
	"os"
	"testing"

	"miconverter/server/internal/config"
)

// golden.json stammt aus dem Python-Backend (testdata/gen_golden.py).
type golden struct {
	Secrets []string `json:"secrets"`
	Tokens  []struct {
		RandomHex string            `json:"randomHex"`
		Token     string            `json:"token"`
		HashHex   string            `json:"hashHex"`
		CSRF      map[string]string `json:"csrf"`
	} `json:"tokens"`
	Plausible   map[string]bool `json:"plausible"`
	CSRFMatches []struct {
		Expected string  `json:"expected"`
		Given    *string `json:"given"`
		Match    bool    `json:"match"`
	} `json:"csrfMatches"`
	Cookies []struct {
		Secure     bool   `json:"secure"`
		TTLSeconds int    `json:"ttlSeconds"`
		Name       string `json:"name"`
		SetCookie  string `json:"setCookie"`
	} `json:"cookies"`
	CookieParsing []struct {
		Cookie string  `json:"cookie"`
		Name   string  `json:"name"`
		Value  *string `json:"value"`
	} `json:"cookieParsing"`
	Origins []struct {
		Origin         *string  `json:"origin"`
		SecFetchSite   *string  `json:"secFetchSite"`
		AllowedOrigins []string `json:"allowedOrigins"`
		Allowed        bool     `json:"allowed"`
	} `json:"origins"`
	ClientIPs []struct {
		Peer           *string  `json:"peer"`
		XFF            *string  `json:"xff"`
		TrustedProxies []string `json:"trustedProxies"`
		ClientIP       string   `json:"clientIp"`
	} `json:"clientIps"`
	RateKeys []struct {
		Kind     string `json:"kind"`
		Identity string `json:"identity"`
		Key      string `json:"key"`
	} `json:"rateKeys"`
}

func loadGolden(t *testing.T) golden {
	t.Helper()
	data, err := os.ReadFile("testdata/golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var g golden
	if err := json.Unmarshal(data, &g); err != nil {
		t.Fatal(err)
	}
	if len(g.Tokens) == 0 || len(g.ClientIPs) == 0 {
		t.Fatal("golden.json unvollständig")
	}
	return g
}

func TestGoldenTokensHashesAndCSRF(t *testing.T) {
	g := loadGolden(t)
	for _, tc := range g.Tokens {
		raw, err := hex.DecodeString(tc.RandomHex)
		if err != nil {
			t.Fatal(err)
		}
		token := encodeToken(raw)
		if token != tc.Token {
			t.Errorf("Token %q, Python %q", token, tc.Token)
		}
		if !IsPlausibleToken(token) {
			t.Errorf("Token %q nicht plausibel", token)
		}
		hash := HashToken(token)
		if hex.EncodeToString(hash[:]) != tc.HashHex {
			t.Errorf("Hash %x, Python %s", hash, tc.HashHex)
		}
		if len(tc.CSRF) != len(g.Secrets) {
			t.Fatal("CSRF-Fälle fehlen")
		}
		for secret, want := range tc.CSRF {
			if got := CSRFToken(config.NewSecret(secret), hash); got != want {
				t.Errorf("CSRF(%q) = %q, Python %q", secret, got, want)
			}
		}
	}
}

func TestGoldenPlausibleAndMatches(t *testing.T) {
	g := loadGolden(t)
	for token, want := range g.Plausible {
		if IsPlausibleToken(token) != want {
			t.Errorf("IsPlausibleToken(%q) != %v", token, want)
		}
	}
	for _, tc := range g.CSRFMatches {
		given, ok := "", tc.Given != nil
		if ok {
			given = *tc.Given
		}
		if CSRFMatches(tc.Expected, given, ok) != tc.Match {
			t.Errorf("CSRFMatches(%v) != %v", tc.Given, tc.Match)
		}
	}
}

func TestGoldenCookies(t *testing.T) {
	g := loadGolden(t)
	for _, tc := range g.Cookies {
		if CookieName(tc.Secure) != tc.Name {
			t.Errorf("CookieName(%v) = %q", tc.Secure, CookieName(tc.Secure))
		}
		if got := SetCookieValue(tc.Secure, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", tc.TTLSeconds); got != tc.SetCookie {
			t.Errorf("Set-Cookie\n%s\n%s", got, tc.SetCookie)
		}
	}
	for _, tc := range g.CookieParsing {
		r := httptest.NewRequest("GET", "/", nil)
		if tc.Cookie != "" {
			r.Header.Set("Cookie", tc.Cookie)
		}
		value, ok := CookieValue(r, tc.Name)
		switch {
		case tc.Value == nil && ok:
			t.Errorf("%q: Cookie %q gefunden, Python nicht", tc.Cookie, value)
		case tc.Value != nil && (!ok || value != *tc.Value):
			t.Errorf("%q: %q/%v, Python %q", tc.Cookie, value, ok, *tc.Value)
		}
	}
}

func TestGoldenOrigins(t *testing.T) {
	g := loadGolden(t)
	for _, tc := range g.Origins {
		r := httptest.NewRequest("POST", "/", nil)
		if tc.Origin != nil {
			r.Header["Origin"] = []string{*tc.Origin}
		}
		if tc.SecFetchSite != nil {
			r.Header.Set("Sec-Fetch-Site", *tc.SecFetchSite)
		}
		if OriginAllowed(r, tc.AllowedOrigins) != tc.Allowed {
			t.Errorf("Origin %v / Sec-Fetch-Site %v: erwartet %v", deref(tc.Origin), deref(tc.SecFetchSite), tc.Allowed)
		}
	}
}

func TestGoldenClientIPs(t *testing.T) {
	g := loadGolden(t)
	for _, tc := range g.ClientIPs {
		var trusted []netip.Prefix
		for _, p := range tc.TrustedProxies {
			// Gleiche Regel wie config.TRUSTED_PROXIES.
			if pre, err := netip.ParsePrefix(p); err == nil {
				trusted = append(trusted, pre.Masked())
			} else {
				a := netip.MustParseAddr(p)
				trusted = append(trusted, netip.PrefixFrom(a, a.BitLen()))
			}
		}
		remote := ""
		if tc.Peer != nil {
			// Wie net/http: "host:port", IPv6 in Klammern.
			remote = net.JoinHostPort(*tc.Peer, "1234")
		}
		var xff []string
		if tc.XFF != nil {
			xff = []string{*tc.XFF}
		}
		if got := ClientIP(remote, xff, trusted); got != tc.ClientIP {
			t.Errorf("Peer %v, XFF %v: %q, Python %q", deref(tc.Peer), deref(tc.XFF), got, tc.ClientIP)
		}
	}
}

func TestGoldenRateLimitKeys(t *testing.T) {
	g := loadGolden(t)
	for _, tc := range g.RateKeys {
		if got := RateLimitKey(tc.Kind, tc.Identity); got != tc.Key {
			t.Errorf("RateLimitKey(%q, %q) = %q, Python %q", tc.Kind, tc.Identity, got, tc.Key)
		}
	}
}

func deref(s *string) string {
	if s == nil {
		return "<fehlt>"
	}
	return *s
}
