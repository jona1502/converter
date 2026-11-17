// Package config liest die Einstellungen aus Umgebungsvariablen mit dem
// Präfix CONVERTER_. Namen, Standardwerte, Einheiten und Prüfregeln
// entsprechen backend/app/core/config.py und docs/backend/api-contract.md §6.
//
// Sicherheitsprinzip wie bisher: Standard für CONVERTER_ENVIRONMENT ist
// production. Wer die Umgebung vergisst, bekommt die strenge Prüfung.
// Fehlermeldungen nennen nur den Variablennamen, nie den Wert.
package config

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"log/slog"
	"math"
	"net/netip"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	Prefix             = "CONVERTER_"
	MinSecretKeyLength = 32
)

type Environment string

const (
	Development Environment = "development"
	Test        Environment = "test"
	Production  Environment = "production"
)

// Config: alle Einstellungen. Nach Load unveränderlich verwenden.
type Config struct {
	Environment Environment
	LogLevel    string // DEBUG, INFO, WARNING, ERROR

	// Pflicht in production; sonst ohne Angabe ein zufälliger Schlüssel je
	// Prozess (siehe EffectiveSecretKey).
	SecretKey Secret
	// Normalisierte Origins "scheme://host[:port]" in Kleinschreibung.
	AllowedOrigins []string
	// Reverse Proxies, deren X-Forwarded-For vertraut wird.
	TrustedProxies      []netip.Prefix
	SessionCookieSecure bool

	StorageDir       string
	DatabaseURL      Secret
	RedisURL         Secret
	DatabasePoolSize int

	HealthCheckTimeout time.Duration

	// Grenzwerte (Vertrag §6).
	MarkdownMaxInputBytes    int64
	MarkdownMaxOutputBytes   int64
	MarkdownMaxPages         int64
	ImageMaxInputBytes       int64
	ImageMaxPixels           int64
	ImageMaxEdge             int
	ImageMaxOutputBytes      int64
	PdfMaxInputBytes         int64
	PdfMaxResultsTotalBytes  int64
	PdfImageMaxPixels        int64
	AudioMaxInputBytes       int64
	AudioMaxDurationSeconds  int64
	AudioMaxChannels         int64
	AudioMaxSampleRate       int64
	AudioMaxOutputBytes      int64
	JobTTL                   time.Duration
	JobMaxAttempts           int
	SessionTTL               time.Duration
	SessionMaxActiveJobs     int
	GlobalMaxActiveJobs      int
	SessionCreatesPerMinute  int
	IPCreatesPerMinute       int
	SessionReplaysPerMinute  int
	SessionNewPerMinute      int
	ImageTimeout             time.Duration
	PdfTimeout               time.Duration
	AudioTimeout             time.Duration
	MarkdownTimeout          time.Duration
	StorageBudgetBytes       int64
	CleanupInterval          time.Duration
	DownloadMax              time.Duration
	PhysicalDeleteMax        time.Duration
	UploadConcurrency        int
	WorkerConcurrency        int
	UploadMax                time.Duration
	developmentSecretKeyOnly Secret
}

// Error sammelt alle Konfigurationsfehler. Enthält nur Variablennamen und
// Regeln, keine Werte.
type Error struct {
	Problems []string
}

func (e *Error) Error() string {
	return "ungültige Konfiguration: " + strings.Join(e.Problems, "; ")
}

// LookupFunc liefert den Wert einer Umgebungsvariable (wie os.LookupEnv).
type LookupFunc func(name string) (string, bool)

// FromEnv lädt die Konfiguration aus der Prozessumgebung.
func FromEnv() (*Config, error) { return Load(os.LookupEnv) }

// Load lädt und prüft die Konfiguration. Bei Fehlern ist das Ergebnis ein *Error.
func Load(lookup LookupFunc) (*Config, error) {
	p := &parser{lookup: lookup}
	c := &Config{}

	c.Environment = Environment(p.choice("ENVIRONMENT", string(Production),
		string(Development), string(Test), string(Production)))
	c.LogLevel = p.logLevel("LOG_LEVEL", "INFO")
	c.SecretKey = p.secret("SECRET_KEY", false)
	c.AllowedOrigins = p.origins("ALLOWED_ORIGINS")
	c.TrustedProxies = p.proxies("TRUSTED_PROXIES")
	c.SessionCookieSecure = p.boolean("SESSION_COOKIE_SECURE", true)

	c.StorageDir = p.nonEmpty("STORAGE_DIR", "/data/storage")
	c.DatabaseURL = p.databaseURL("DATABASE_URL")
	c.RedisURL = p.secret("REDIS_URL", true)
	c.DatabasePoolSize = int(p.intRange("DATABASE_POOL_SIZE", 5, 1, 50))
	c.HealthCheckTimeout = p.floatSeconds("HEALTH_CHECK_TIMEOUT_SECONDS", 2.0, 30)

	c.MarkdownMaxInputBytes = p.positive("MARKDOWN_MAX_INPUT_BYTES", 2_097_152)
	c.MarkdownMaxOutputBytes = p.positive("MARKDOWN_MAX_OUTPUT_BYTES", 20_971_520)
	c.MarkdownMaxPages = p.positive("MARKDOWN_MAX_PAGES", 300)
	c.MarkdownTimeout = p.seconds("MARKDOWN_TIMEOUT_SECONDS", 120)
	c.ImageMaxInputBytes = p.positive("IMAGE_MAX_INPUT_BYTES", 52_428_800)
	c.ImageMaxPixels = p.positive("IMAGE_MAX_PIXELS", 40_000_000)
	c.ImageMaxEdge = int(p.positive("IMAGE_MAX_EDGE", 16_384))
	c.ImageMaxOutputBytes = p.positive("IMAGE_MAX_OUTPUT_BYTES", 104_857_600)
	c.PdfMaxInputBytes = p.positive("PDF_MAX_INPUT_BYTES", 100_000_000)
	c.PdfMaxResultsTotalBytes = p.positive("PDF_MAX_RESULTS_TOTAL_BYTES", 300_000_000)
	c.PdfImageMaxPixels = p.positive("PDF_IMAGE_MAX_PIXELS", 40_000_000)
	c.AudioMaxInputBytes = p.positive("AUDIO_MAX_INPUT_BYTES", 104_857_600)
	c.AudioMaxDurationSeconds = p.positive("AUDIO_MAX_DURATION_SECONDS", 1800)
	c.AudioMaxChannels = p.positive("AUDIO_MAX_CHANNELS", 8)
	c.AudioMaxSampleRate = p.positive("AUDIO_MAX_SAMPLE_RATE", 192_000)
	c.AudioMaxOutputBytes = p.positive("AUDIO_MAX_OUTPUT_BYTES", 419_430_400)

	c.JobTTL = p.seconds("JOB_TTL_SECONDS", 3600)
	c.JobMaxAttempts = int(p.positive("JOB_MAX_ATTEMPTS", 3))
	c.SessionTTL = p.seconds("SESSION_TTL_SECONDS", 86_400)
	c.SessionMaxActiveJobs = int(p.positive("SESSION_MAX_ACTIVE_JOBS", 3))
	c.GlobalMaxActiveJobs = int(p.positive("GLOBAL_MAX_ACTIVE_JOBS", 50))
	c.SessionCreatesPerMinute = int(p.positive("SESSION_CREATES_PER_MINUTE", 10))
	c.IPCreatesPerMinute = int(p.positive("IP_CREATES_PER_MINUTE", 10))
	c.SessionReplaysPerMinute = int(p.positive("SESSION_REPLAYS_PER_MINUTE", 30))
	c.SessionNewPerMinute = int(p.positive("SESSION_NEW_PER_MINUTE", 30))

	c.ImageTimeout = p.seconds("IMAGE_TIMEOUT_SECONDS", 120)
	c.PdfTimeout = p.seconds("PDF_TIMEOUT_SECONDS", 300)
	c.AudioTimeout = p.seconds("AUDIO_TIMEOUT_SECONDS", 300)

	c.StorageBudgetBytes = p.positive("STORAGE_BUDGET_BYTES", 5_000_000_000)
	c.CleanupInterval = p.seconds("CLEANUP_INTERVAL_SECONDS", 60)
	c.DownloadMax = p.seconds("DOWNLOAD_MAX_SECONDS", 300)
	c.PhysicalDeleteMax = p.seconds("PHYSICAL_DELETE_MAX_SECONDS", 600)
	c.UploadConcurrency = int(p.positive("UPLOAD_CONCURRENCY", 2))
	c.UploadMax = p.seconds("UPLOAD_MAX_SECONDS", 600)
	c.WorkerConcurrency = int(p.positive("WORKER_CONCURRENCY", 1))

	// Feldübergreifende Regeln nur bei gültigen Einzelwerten (wie der
	// model_validator in Python).
	if len(p.problems) == 0 {
		p.problems = append(p.problems, c.crossChecks()...)
	}
	if len(p.problems) > 0 {
		return nil, &Error{Problems: p.problems}
	}

	if !c.SecretKey.IsSet() {
		key, err := randomKey()
		if err != nil {
			return nil, err
		}
		c.developmentSecretKeyOnly = key
	}
	return c, nil
}

func (c *Config) crossChecks() []string {
	var problems []string
	if c.SessionTTL < c.JobTTL {
		problems = append(problems, Prefix+"SESSION_TTL_SECONDS muss JOB_TTL_SECONDS abdecken")
	}
	need := max(c.DownloadMax, c.ImageTimeout+c.CleanupInterval, c.PdfTimeout+c.CleanupInterval,
		c.AudioTimeout+c.CleanupInterval, c.MarkdownTimeout+c.CleanupInterval) +
		c.CleanupInterval + 10*time.Second
	if c.PhysicalDeleteMax < need {
		problems = append(problems, Prefix+"PHYSICAL_DELETE_MAX_SECONDS muss Download, Parser-Zeitlimit und Cleanup-Karenz abdecken")
	}
	if c.SecretKey.IsSet() && utf8.RuneCountInString(c.SecretKey.Reveal()) < MinSecretKeyLength {
		problems = append(problems, Prefix+"SECRET_KEY muss mindestens 32 Zeichen lang sein")
	}
	if c.Environment != Production {
		return problems
	}
	if !c.SecretKey.IsSet() {
		problems = append(problems, Prefix+"SECRET_KEY ist in production Pflicht")
	}
	if !c.SessionCookieSecure {
		problems = append(problems, Prefix+"SESSION_COOKIE_SECURE darf in production nicht false sein")
	}
	if len(c.AllowedOrigins) == 0 {
		problems = append(problems, Prefix+"ALLOWED_ORIGINS ist in production Pflicht")
	}
	if !c.DatabaseURL.IsSet() {
		problems = append(problems, Prefix+"DATABASE_URL ist in production Pflicht")
	}
	return problems
}

// EffectiveSecretKey: konfigurierter Schlüssel oder (nur außerhalb
// production möglich) ein beim Laden erzeugter Zufallswert.
func (c *Config) EffectiveSecretKey() Secret {
	if c.SecretKey.IsSet() {
		return c.SecretKey
	}
	return c.developmentSecretKeyOnly
}

// IsProduction meldet die strenge Produktionsumgebung.
func (c *Config) IsProduction() bool { return c.Environment == Production }

// MaxUploadInputBytes: größte Eingabe über alle Werkzeuge.
func (c *Config) MaxUploadInputBytes() int64 {
	return max(c.ImageMaxInputBytes, c.PdfMaxInputBytes, c.AudioMaxInputBytes, c.MarkdownMaxInputBytes)
}

// SlogLevel bildet LogLevel auf log/slog ab.
func (c *Config) SlogLevel() slog.Level {
	switch c.LogLevel {
	case "DEBUG":
		return slog.LevelDebug
	case "WARNING":
		return slog.LevelWarn
	case "ERROR":
		return slog.LevelError
	}
	return slog.LevelInfo
}

func randomKey() (Secret, error) {
	b := make([]byte, MinSecretKeyLength)
	if _, err := rand.Read(b); err != nil {
		return Secret{}, err
	}
	return NewSecret(base64.RawURLEncoding.EncodeToString(b)), nil
}

// --- Einzelwerte -------------------------------------------------------------

type parser struct {
	lookup   LookupFunc
	problems []string
}

func (p *parser) get(name string) (string, bool) {
	return p.lookup(Prefix + name)
}

func (p *parser) fail(name, rule string) {
	p.problems = append(p.problems, Prefix+name+" "+rule)
}

func (p *parser) choice(name, def string, allowed ...string) string {
	v, ok := p.get(name)
	if !ok {
		return def
	}
	for _, a := range allowed {
		if v == a {
			return v
		}
	}
	p.fail(name, "erwartet einen von: "+strings.Join(allowed, ", "))
	return def
}

func (p *parser) logLevel(name, def string) string {
	v, ok := p.get(name)
	if !ok {
		return def
	}
	switch up := strings.ToUpper(v); up {
	case "DEBUG", "INFO", "WARNING", "ERROR":
		return up
	}
	p.fail(name, "erwartet DEBUG, INFO, WARNING oder ERROR")
	return def
}

// secret: emptyIsUnset gilt für URLs (leerer Wert = nicht konfiguriert);
// ein leerer Schlüssel ist dagegen gesetzt und scheitert an der Mindestlänge.
func (p *parser) secret(name string, emptyIsUnset bool) Secret {
	v, ok := p.get(name)
	if !ok || (emptyIsUnset && strings.TrimSpace(v) == "") {
		return Secret{}
	}
	return NewSecret(v)
}

// databaseURL bildet die SQLAlchemy-Schreibweise "postgresql+psycopg://"
// (lokale Testaufrufe, siehe compose.yaml) auf "postgresql://" ab.
func (p *parser) databaseURL(name string) Secret {
	s := p.secret(name, true)
	if !s.IsSet() {
		return s
	}
	v := s.Reveal()
	for _, driver := range []string{"postgresql+psycopg://", "postgres+psycopg://"} {
		if rest, ok := strings.CutPrefix(v, driver); ok {
			return NewSecret("postgresql://" + rest)
		}
	}
	return s
}

func (p *parser) nonEmpty(name, def string) string {
	v, ok := p.get(name)
	if !ok {
		return def
	}
	if strings.TrimSpace(v) == "" {
		p.fail(name, "darf nicht leer sein")
		return def
	}
	return v
}

// boolean akzeptiert dieselben Schreibweisen wie Pydantic.
func (p *parser) boolean(name string, def bool) bool {
	v, ok := p.get(name)
	if !ok {
		return def
	}
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "on", "t", "true", "y", "yes":
		return true
	case "0", "off", "f", "false", "n", "no":
		return false
	}
	p.fail(name, "erwartet true oder false")
	return def
}

func (p *parser) integer(name string, def int64) (int64, bool) {
	v, ok := p.get(name)
	if !ok {
		return def, true
	}
	n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
	if err != nil {
		p.fail(name, "erwartet eine ganze Zahl")
		return def, false
	}
	return n, true
}

func (p *parser) positive(name string, def int64) int64 {
	n, ok := p.integer(name, def)
	if !ok {
		return def
	}
	if n <= 0 {
		p.fail(name, "muss größer als 0 sein")
		return def
	}
	return n
}

func (p *parser) intRange(name string, def, lo, hi int64) int64 {
	n, ok := p.integer(name, def)
	if !ok {
		return def
	}
	if n < lo || n > hi {
		p.fail(name, "muss zwischen "+strconv.FormatInt(lo, 10)+" und "+strconv.FormatInt(hi, 10)+" liegen")
		return def
	}
	return n
}

// maxSeconds verhindert einen Überlauf von time.Duration (~292 Jahre).
const maxSeconds = int64(math.MaxInt64 / int64(time.Second) / 4)

func (p *parser) seconds(name string, def int64) time.Duration {
	n := p.positive(name, def)
	if n > maxSeconds {
		p.fail(name, "ist zu groß")
		n = def
	}
	return time.Duration(n) * time.Second
}

func (p *parser) floatSeconds(name string, def, hi float64) time.Duration {
	v, ok := p.get(name)
	if !ok {
		return time.Duration(def * float64(time.Second))
	}
	f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		p.fail(name, "erwartet eine Zahl")
		return time.Duration(def * float64(time.Second))
	}
	if f <= 0 || f > hi {
		p.fail(name, "muss größer als 0 und höchstens "+strconv.FormatFloat(hi, 'f', -1, 64)+" sein")
		return time.Duration(def * float64(time.Second))
	}
	return time.Duration(f * float64(time.Second))
}

// splitCSV: kommagetrennt, Leerraum entfernt, leere Einträge ignoriert
// (wie _split_csv in Python; JSON-Listen werden dort nicht dekodiert).
func splitCSV(v string) []string {
	var out []string
	for item := range strings.SplitSeq(v, ",") {
		if item = strings.TrimSpace(item); item != "" {
			out = append(out, item)
		}
	}
	return out
}

func (p *parser) origins(name string) []string {
	v, ok := p.get(name)
	if !ok {
		return nil
	}
	var out []string
	for _, item := range splitCSV(v) {
		origin, ok := normalizeOrigin(item)
		if !ok {
			p.fail(name, "erwartet Origins wie 'https://host[:port]'")
			return nil
		}
		out = append(out, origin)
	}
	return out
}

func normalizeOrigin(s string) (string, bool) {
	u, err := url.Parse(s)
	if err != nil {
		return "", false
	}
	scheme := strings.ToLower(u.Scheme)
	switch {
	case scheme != "http" && scheme != "https",
		u.Opaque != "", u.User != nil, u.Host == "",
		strings.Contains(u.Host, "@"),
		u.Path != "" && u.Path != "/",
		u.RawQuery != "", u.Fragment != "":
		return "", false
	}
	return scheme + "://" + strings.ToLower(u.Host), true
}

func (p *parser) proxies(name string) []netip.Prefix {
	v, ok := p.get(name)
	if !ok {
		return nil
	}
	var out []netip.Prefix
	for _, item := range splitCSV(v) {
		prefix, ok := parseNetwork(item)
		if !ok {
			p.fail(name, "erwartet IP-Adressen oder CIDR-Netze")
			return nil
		}
		out = append(out, prefix)
	}
	return out
}

// parseNetwork wie ipaddress.ip_network(strict=False): einzelne Adresse →
// Hostnetz, gesetzte Hostbits werden abgeschnitten.
func parseNetwork(s string) (netip.Prefix, bool) {
	if strings.Contains(s, "/") {
		prefix, err := netip.ParsePrefix(s)
		if err != nil {
			return netip.Prefix{}, false
		}
		return prefix.Masked(), true
	}
	addr, err := netip.ParseAddr(s)
	if err != nil || addr.Zone() != "" {
		return netip.Prefix{}, false
	}
	return netip.PrefixFrom(addr, addr.BitLen()), true
}

// IsConfigError meldet, ob err ein Konfigurationsfehler (*Error) ist.
func IsConfigError(err error) bool {
	var ce *Error
	return errors.As(err, &ce)
}
