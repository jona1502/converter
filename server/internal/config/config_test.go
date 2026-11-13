package config

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/netip"
	"strings"
	"testing"
	"time"
)

const testSecret = "test-secret-key-0123456789abcdefghijklmnop"

func env(m map[string]string) LookupFunc {
	return func(name string) (string, bool) {
		v, ok := m[name]
		return v, ok
	}
}

func production(extra map[string]string) map[string]string {
	m := map[string]string{
		"CONVERTER_ENVIRONMENT":     "production",
		"CONVERTER_DATABASE_URL":    "postgresql://converter:converter@localhost/converter_test",
		"CONVERTER_SECRET_KEY":      testSecret,
		"CONVERTER_ALLOWED_ORIGINS": "https://converter.example",
	}
	for k, v := range extra {
		if v == "<unset>" {
			delete(m, k)
			continue
		}
		m[k] = v
	}
	return m
}

func mustLoad(t *testing.T, m map[string]string) *Config {
	t.Helper()
	c, err := Load(env(m))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	return c
}

func TestDefaultsMatchContractLimits(t *testing.T) {
	c := mustLoad(t, map[string]string{"CONVERTER_ENVIRONMENT": "test"})
	checks := []struct {
		name      string
		got, want any
	}{
		{"ImageMaxInputBytes", c.ImageMaxInputBytes, int64(52_428_800)},
		{"ImageMaxPixels", c.ImageMaxPixels, int64(40_000_000)},
		{"ImageMaxEdge", c.ImageMaxEdge, 16_384},
		{"ImageMaxOutputBytes", c.ImageMaxOutputBytes, int64(104_857_600)},
		{"PdfMaxInputBytes", c.PdfMaxInputBytes, int64(100_000_000)},
		{"PdfMaxResultsTotalBytes", c.PdfMaxResultsTotalBytes, int64(300_000_000)},
		{"PdfImageMaxPixels", c.PdfImageMaxPixels, int64(40_000_000)},
		{"AudioMaxInputBytes", c.AudioMaxInputBytes, int64(104_857_600)},
		{"AudioMaxDurationSeconds", c.AudioMaxDurationSeconds, int64(1800)},
		{"AudioMaxChannels", c.AudioMaxChannels, int64(8)},
		{"AudioMaxSampleRate", c.AudioMaxSampleRate, int64(192_000)},
		{"AudioMaxOutputBytes", c.AudioMaxOutputBytes, int64(419_430_400)},
		{"AudioTimeout", c.AudioTimeout, 300 * time.Second},
		{"JobTTL", c.JobTTL, time.Hour},
		{"SessionMaxActiveJobs", c.SessionMaxActiveJobs, 3},
		{"GlobalMaxActiveJobs", c.GlobalMaxActiveJobs, 50},
		{"SessionCreatesPerMinute", c.SessionCreatesPerMinute, 10},
		{"IPCreatesPerMinute", c.IPCreatesPerMinute, 10},
		{"SessionReplaysPerMinute", c.SessionReplaysPerMinute, 30},
		{"SessionNewPerMinute", c.SessionNewPerMinute, 30},
		{"ImageTimeout", c.ImageTimeout, 120 * time.Second},
		{"PdfTimeout", c.PdfTimeout, 300 * time.Second},
		{"StorageBudgetBytes", c.StorageBudgetBytes, int64(5_000_000_000)},
		{"CleanupInterval", c.CleanupInterval, 60 * time.Second},
		{"DownloadMax", c.DownloadMax, 300 * time.Second},
		{"PhysicalDeleteMax", c.PhysicalDeleteMax, 600 * time.Second},
		{"UploadConcurrency", c.UploadConcurrency, 2},
		{"UploadMax", c.UploadMax, 600 * time.Second},
		{"JobMaxAttempts", c.JobMaxAttempts, 3},
		{"SessionTTL", c.SessionTTL, 24 * time.Hour},
		{"SessionCookieSecure", c.SessionCookieSecure, true},
		{"StorageDir", c.StorageDir, "/data/storage"},
		{"DatabasePoolSize", c.DatabasePoolSize, 5},
		{"HealthCheckTimeout", c.HealthCheckTimeout, 2 * time.Second},
		{"LogLevel", c.LogLevel, "INFO"},
		// Audio (100 MiB) ist die größte Eingabe und bestimmt die Reservierung.
		{"MaxUploadInputBytes", c.MaxUploadInputBytes(), int64(104_857_600)},
	}
	for _, tc := range checks {
		if tc.got != tc.want {
			t.Errorf("%s = %v, erwartet %v", tc.name, tc.got, tc.want)
		}
	}
	if c.DatabaseURL.IsSet() || c.RedisURL.IsSet() || c.SecretKey.IsSet() {
		t.Error("ohne Angabe dürfen keine Secrets gesetzt sein")
	}
}

func TestDefaultEnvironmentIsProductionAndStrict(t *testing.T) {
	_, err := Load(env(nil))
	if err == nil || !strings.Contains(err.Error(), "SECRET_KEY ist in production Pflicht") {
		t.Fatalf("erwartet Produktionsfehler, erhalten %v", err)
	}
	if !IsConfigError(err) {
		t.Fatal("erwartet *Error")
	}
}

func TestValidProductionSettings(t *testing.T) {
	c := mustLoad(t, production(nil))
	if !c.IsProduction() {
		t.Fatal("erwartet production")
	}
	if c.EffectiveSecretKey().Reveal() != testSecret {
		t.Fatal("konfigurierter Schlüssel erwartet")
	}
}

func TestProductionRejectsUnsafeSettings(t *testing.T) {
	cases := []struct {
		override map[string]string
		message  string
	}{
		{map[string]string{"CONVERTER_SECRET_KEY": "<unset>"}, "SECRET_KEY ist in production Pflicht"},
		{map[string]string{"CONVERTER_SECRET_KEY": "zu-kurz"}, "mindestens 32 Zeichen"},
		{map[string]string{"CONVERTER_SESSION_COOKIE_SECURE": "false"}, "SESSION_COOKIE_SECURE"},
		{map[string]string{"CONVERTER_ALLOWED_ORIGINS": ""}, "ALLOWED_ORIGINS ist in production Pflicht"},
		{map[string]string{"CONVERTER_ALLOWED_ORIGINS": "<unset>"}, "ALLOWED_ORIGINS ist in production Pflicht"},
		{map[string]string{"CONVERTER_DATABASE_URL": "<unset>"}, "DATABASE_URL ist in production Pflicht"},
		{map[string]string{"CONVERTER_DATABASE_URL": " "}, "DATABASE_URL ist in production Pflicht"},
	}
	for _, tc := range cases {
		_, err := Load(env(production(tc.override)))
		if err == nil || !strings.Contains(err.Error(), tc.message) {
			t.Errorf("%v: erwartet %q, erhalten %v", tc.override, tc.message, err)
		}
	}
}

func TestReadsEnvironmentWithPrefixAndCSVLists(t *testing.T) {
	c := mustLoad(t, production(map[string]string{
		"CONVERTER_ALLOWED_ORIGINS":       "https://Converter.example, http://localhost:4321",
		"CONVERTER_TRUSTED_PROXIES":       "10.0.0.0/8,::1, 172.30.218.10/32,192.168.1.7/24",
		"CONVERTER_IMAGE_MAX_INPUT_BYTES": "1000",
		"CONVERTER_LOG_LEVEL":             "debug",
	}))
	if got := strings.Join(c.AllowedOrigins, " "); got != "https://converter.example http://localhost:4321" {
		t.Errorf("AllowedOrigins = %q", got)
	}
	want := []netip.Prefix{
		netip.MustParsePrefix("10.0.0.0/8"),
		netip.MustParsePrefix("::1/128"),
		netip.MustParsePrefix("172.30.218.10/32"),
		netip.MustParsePrefix("192.168.1.0/24"),
	}
	if fmt.Sprint(c.TrustedProxies) != fmt.Sprint(want) {
		t.Errorf("TrustedProxies = %v, erwartet %v", c.TrustedProxies, want)
	}
	if c.ImageMaxInputBytes != 1000 || c.LogLevel != "DEBUG" {
		t.Errorf("Werte nicht übernommen: %d %s", c.ImageMaxInputBytes, c.LogLevel)
	}
}

// Werte wie in compose.yaml für den lokalen Stack.
func TestComposeDevelopmentValues(t *testing.T) {
	c := mustLoad(t, map[string]string{
		"CONVERTER_ENVIRONMENT":           "development",
		"CONVERTER_SECRET_KEY":            "local-development-only-change-before-hosting-2026",
		"CONVERTER_ALLOWED_ORIGINS":       "http://localhost:8080,http://127.0.0.1:8080",
		"CONVERTER_SESSION_COOKIE_SECURE": "false",
		"CONVERTER_DATABASE_URL":          "postgresql://converter:converter@db:5432/converter",
		"CONVERTER_REDIS_URL":             "redis://broker:6379/0",
		"CONVERTER_IP_CREATES_PER_MINUTE": "10",
		"CONVERTER_STORAGE_DIR":           "/data/storage",
		"CONVERTER_TRUSTED_PROXIES":       "172.30.218.10/32",
	})
	if c.SessionCookieSecure || len(c.AllowedOrigins) != 2 || !c.RedisURL.IsSet() {
		t.Fatalf("Compose-Werte falsch übernommen")
	}
}

func TestSQLAlchemyDriverPrefixIsNormalized(t *testing.T) {
	c := mustLoad(t, production(map[string]string{
		"CONVERTER_DATABASE_URL": "postgresql+psycopg://u:p@127.0.0.1:55432/converter",
	}))
	if got := c.DatabaseURL.Reveal(); got != "postgresql://u:p@127.0.0.1:55432/converter" {
		t.Fatalf("DatabaseURL nicht normalisiert")
	}
}

func TestInvalidOriginsAreRejected(t *testing.T) {
	for _, origin := range []string{
		"converter.example", "https://converter.example/path", "ftp://x", "https://u@host",
		"https://host?x=1", "https://host#frag", "https://", `["https://host"]`,
	} {
		_, err := Load(env(map[string]string{"CONVERTER_ENVIRONMENT": "test", "CONVERTER_ALLOWED_ORIGINS": origin}))
		if err == nil || !strings.Contains(err.Error(), "ALLOWED_ORIGINS") {
			t.Errorf("%q: erwartet Fehler, erhalten %v", origin, err)
		}
		// "https://" steht im Regeltext selbst.
		if err != nil && origin != "https://" && strings.Contains(err.Error(), origin) {
			t.Errorf("Fehlermeldung enthält den Wert %q", origin)
		}
	}
}

func TestOriginTrailingSlashIsAccepted(t *testing.T) {
	c := mustLoad(t, map[string]string{"CONVERTER_ENVIRONMENT": "test", "CONVERTER_ALLOWED_ORIGINS": "HTTPS://Host.Example:8443/"})
	if c.AllowedOrigins[0] != "https://host.example:8443" {
		t.Fatalf("Origin = %q", c.AllowedOrigins[0])
	}
}

func TestInvalidProxyIsRejected(t *testing.T) {
	for _, v := range []string{"not-an-ip", "10.0.0.0/33", "fe80::1%eth0"} {
		_, err := Load(env(map[string]string{"CONVERTER_ENVIRONMENT": "test", "CONVERTER_TRUSTED_PROXIES": v}))
		if err == nil || !strings.Contains(err.Error(), "TRUSTED_PROXIES") {
			t.Errorf("%q: erwartet Fehler, erhalten %v", v, err)
		}
	}
}

func TestInvalidScalarsAreRejected(t *testing.T) {
	cases := map[string]string{
		"CONVERTER_IMAGE_MAX_INPUT_BYTES":        "0",
		"CONVERTER_JOB_TTL_SECONDS":              "-1",
		"CONVERTER_PDF_TIMEOUT_SECONDS":          "abc",
		"CONVERTER_DATABASE_POOL_SIZE":           "51",
		"CONVERTER_HEALTH_CHECK_TIMEOUT_SECONDS": "0",
		"CONVERTER_SESSION_COOKIE_SECURE":        "vielleicht",
		"CONVERTER_ENVIRONMENT":                  "Production",
		"CONVERTER_LOG_LEVEL":                    "TRACE",
		"CONVERTER_STORAGE_DIR":                  "",
		"CONVERTER_UPLOAD_MAX_SECONDS":           "",
		"CONVERTER_AUDIO_MAX_CHANNELS":           "0",
		"CONVERTER_AUDIO_MAX_DURATION_SECONDS":   "-5",
		"CONVERTER_AUDIO_TIMEOUT_SECONDS":        "x",
	}
	for name, value := range cases {
		m := map[string]string{"CONVERTER_ENVIRONMENT": "test", name: value}
		_, err := Load(env(m))
		if err == nil || !strings.Contains(err.Error(), name) {
			t.Errorf("%s=%q: erwartet Fehler mit Variablenname, erhalten %v", name, value, err)
		}
	}
}

func TestBooleanSpellingsLikePydantic(t *testing.T) {
	for v, want := range map[string]bool{"1": true, "Yes": true, "on": true, "T": true, "0": false, "OFF": false, "n": false} {
		c := mustLoad(t, map[string]string{"CONVERTER_ENVIRONMENT": "test", "CONVERTER_SESSION_COOKIE_SECURE": v})
		if c.SessionCookieSecure != want {
			t.Errorf("%q → %v", v, c.SessionCookieSecure)
		}
	}
}

func TestCrossFieldRules(t *testing.T) {
	_, err := Load(env(map[string]string{"CONVERTER_ENVIRONMENT": "test", "CONVERTER_SESSION_TTL_SECONDS": "60"}))
	if err == nil || !strings.Contains(err.Error(), "SESSION_TTL_SECONDS") {
		t.Errorf("Sitzungsdauer < Auftragsdauer muss scheitern: %v", err)
	}
	// 360 + 60 + 10 = 430 Sekunden sind nötig.
	_, err = Load(env(map[string]string{"CONVERTER_ENVIRONMENT": "test", "CONVERTER_PHYSICAL_DELETE_MAX_SECONDS": "429"}))
	if err == nil || !strings.Contains(err.Error(), "PHYSICAL_DELETE_MAX_SECONDS") {
		t.Errorf("zu kurze Löschfrist muss scheitern: %v", err)
	}
	mustLoad(t, map[string]string{"CONVERTER_ENVIRONMENT": "test", "CONVERTER_PHYSICAL_DELETE_MAX_SECONDS": "430"})
	// Längeres Audio-Zeitlimit verlängert die nötige Löschfrist: 400 + 60 + 60 + 10.
	_, err = Load(env(map[string]string{"CONVERTER_ENVIRONMENT": "test", "CONVERTER_AUDIO_TIMEOUT_SECONDS": "400"}))
	if err == nil || !strings.Contains(err.Error(), "PHYSICAL_DELETE_MAX_SECONDS") {
		t.Errorf("Audio-Zeitlimit muss in die Löschfrist eingehen: %v", err)
	}
	mustLoad(t, map[string]string{"CONVERTER_ENVIRONMENT": "test", "CONVERTER_AUDIO_TIMEOUT_SECONDS": "400", "CONVERTER_PHYSICAL_DELETE_MAX_SECONDS": "530"})
	// Mindestlänge gilt auch außerhalb von production.
	_, err = Load(env(map[string]string{"CONVERTER_ENVIRONMENT": "development", "CONVERTER_SECRET_KEY": "kurz"}))
	if err == nil {
		t.Error("kurzer Schlüssel muss auch in development scheitern")
	}
}

func TestDevelopmentWithoutSecretUsesStableEphemeralKey(t *testing.T) {
	c := mustLoad(t, map[string]string{"CONVERTER_ENVIRONMENT": "development", "CONVERTER_SESSION_COOKIE_SECURE": "false"})
	key := c.EffectiveSecretKey().Reveal()
	if len(key) < MinSecretKeyLength {
		t.Fatalf("Schlüssel zu kurz: %d", len(key))
	}
	if c.EffectiveSecretKey().Reveal() != key {
		t.Fatal("Schlüssel muss je Prozess stabil sein")
	}
	other := mustLoad(t, map[string]string{"CONVERTER_ENVIRONMENT": "development"})
	if other.EffectiveSecretKey().Reveal() == key {
		t.Fatal("jede Konfiguration erzeugt einen eigenen Schlüssel")
	}
}

func TestSecretsAreNotExposed(t *testing.T) {
	c := mustLoad(t, production(map[string]string{
		"CONVERTER_DATABASE_URL": "postgresql://u:pw-secret@db/x",
		"CONVERTER_REDIS_URL":    "redis://:redis-secret@redis:6379/0",
	}))
	dev := mustLoad(t, map[string]string{"CONVERTER_ENVIRONMENT": "test"})
	devKey := dev.EffectiveSecretKey().Reveal()

	var logBuf strings.Builder
	logger := slog.New(slog.NewJSONHandler(&logBuf, nil))
	logger.Info("cfg", "secret", c.SecretKey, "db", c.DatabaseURL, "cfg", c)

	jsonOut, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	outputs := []string{
		fmt.Sprintf("%v", c), fmt.Sprintf("%+v", c), fmt.Sprintf("%#v", c),
		fmt.Sprintf("%v", *c), fmt.Sprintf("%+v", *c), fmt.Sprintf("%#v", *c),
		fmt.Sprintf("%s %q %x %d", c.SecretKey, c.SecretKey, c.SecretKey, c.SecretKey),
		c.DatabaseURL.String(), string(jsonOut), logBuf.String(),
		fmt.Sprintf("%+v %#v", *dev, *dev),
	}
	for _, out := range outputs {
		for _, secret := range []string{testSecret, "pw-secret", "redis-secret", devKey} {
			if strings.Contains(out, secret) {
				t.Errorf("Secret sichtbar in Ausgabe: %.80s…", out)
			}
		}
	}
}

func TestValidationErrorsDoNotContainSecrets(t *testing.T) {
	base := map[string]string{
		"CONVERTER_ENVIRONMENT":  "production",
		"CONVERTER_DATABASE_URL": "postgresql://u:pw-secret@db/x",
		"CONVERTER_REDIS_URL":    "redis://:redis-secret@redis:6379/0",
	}
	extras := []map[string]string{
		{"CONVERTER_SECRET_KEY": "kurz-abc-secret"},
		{"CONVERTER_SECRET_KEY": testSecret},
		{"CONVERTER_SECRET_KEY": testSecret, "CONVERTER_IMAGE_MAX_INPUT_BYTES": "-1"},
		{"CONVERTER_SECRET_KEY": testSecret, "CONVERTER_ALLOWED_ORIGINS": "https://pw-secret@host"},
	}
	for _, extra := range extras {
		m := map[string]string{}
		for k, v := range base {
			m[k] = v
		}
		for k, v := range extra {
			m[k] = v
		}
		_, err := Load(env(m))
		if err == nil {
			t.Fatalf("%v: erwartet Fehler", extra)
		}
		text := err.Error() + fmt.Sprintf("%#v %+v", err, err)
		for _, secret := range []string{"kurz-abc-secret", testSecret, "pw-secret", "redis-secret"} {
			if strings.Contains(text, secret) {
				t.Errorf("Fehler enthält Secret %q", secret)
			}
		}
	}
}

func TestSlogLevel(t *testing.T) {
	for in, want := range map[string]slog.Level{"debug": slog.LevelDebug, "INFO": slog.LevelInfo, "warning": slog.LevelWarn, "Error": slog.LevelError} {
		c := mustLoad(t, map[string]string{"CONVERTER_ENVIRONMENT": "test", "CONVERTER_LOG_LEVEL": in})
		if c.SlogLevel() != want {
			t.Errorf("%s → %v", in, c.SlogLevel())
		}
	}
}
