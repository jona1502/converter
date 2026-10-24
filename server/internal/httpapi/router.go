// Package httpapi enthält Routing, Middleware (Request-ID, Sicherheitsheader,
// Zugriffslog, Panic-Recovery), das Fehlerformat und die Health-Endpunkte.
package httpapi

import (
	"context"
	"crypto/rand"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"path"
	"runtime"
	"strings"
	"time"
)

// Prefix: Basis-Pfad aller Routen (Vertrag §2).
const Prefix = "/api/v1"

const healthPrefix = Prefix + "/health/"

// Router verteilt Anfragen über http.ServeMux und legt die Middleware um
// jede Anfrage, auch um unbekannte Routen (404) und falsche Methoden (405),
// die sonst als Klartext von ServeMux beantwortet würden.
type Router struct {
	mux    *http.ServeMux
	routes map[string]string // ServeMux-Muster → Pfadvorlage fürs Log
	logger *slog.Logger
}

// NewRouter erzeugt einen Router ohne Routen.
func NewRouter(logger *slog.Logger) *Router {
	if logger == nil {
		logger = slog.Default()
	}
	return &Router{mux: http.NewServeMux(), routes: map[string]string{}, logger: logger}
}

// Handle registriert h für method und den vollständigen Pfad (mit Prefix),
// z. B. Handle("GET", Prefix+"/jobs/{job_id}", h). Pfadparameter liest der
// Handler über r.PathValue. GET-Routen beantworten auch HEAD (ServeMux).
func (rt *Router) Handle(method, path string, h http.Handler) {
	pattern := method + " " + path
	rt.mux.Handle(pattern, h)
	rt.routes[pattern] = path
}

// HandleFunc wie Handle für Funktionen, die Fehler zurückgeben.
func (rt *Router) HandleFunc(method, path string, f func(http.ResponseWriter, *http.Request) error) {
	rt.Handle(method, path, HandlerFunc(f))
}

type ctxKey int

const (
	requestIDKey ctxKey = iota
	loggerKey
)

// RequestID liefert die Request-ID der laufenden Anfrage ("" außerhalb).
func RequestID(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey).(string)
	return id
}

func requestIDOrNew(ctx context.Context) string {
	if id := RequestID(ctx); id != "" {
		return id
	}
	return newUUID()
}

// Logger liefert den Logger der laufenden Anfrage (sonst slog.Default).
func Logger(ctx context.Context) *slog.Logger {
	if l, ok := ctx.Value(loggerKey).(*slog.Logger); ok {
		return l
	}
	return slog.Default()
}

// AcceptOrGenerateRequestID übernimmt eine vom Proxy gelieferte ID nur im
// Format [A-Za-z0-9-]{8,64}, damit keine Steuerzeichen oder beliebig langen
// Werte in Logs landen; sonst wird eine UUIDv4 erzeugt.
func AcceptOrGenerateRequestID(value string) string {
	if n := len(value); n >= 8 && n <= 64 {
		ok := true
		for i := 0; i < n && ok; i++ {
			c := value[i]
			ok = c == '-' || (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
		}
		if ok {
			return value
		}
	}
	return newUUID()
}

// newUUID erzeugt eine zufällige UUID Version 4.
func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:]) // crypto/rand.Read scheitert laut Doku nie
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// recorder merkt sich den Status für das Zugriffslog. Unwrap erlaubt
// http.ResponseController (z. B. Download-Deadlines) den Zugriff auf den
// eigentlichen Writer.
type recorder struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (r *recorder) WriteHeader(status int) {
	if !r.wroteHeader {
		r.status, r.wroteHeader = status, true
	}
	r.ResponseWriter.WriteHeader(status)
}

func (r *recorder) Write(b []byte) (int, error) {
	if !r.wroteHeader {
		r.WriteHeader(http.StatusOK)
	}
	return r.ResponseWriter.Write(b)
}

func (r *recorder) Flush() { _ = http.NewResponseController(r.ResponseWriter).Flush() }

func (r *recorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

// discardWriter nimmt die Standardantwort von ServeMux (404/405) auf,
// damit nur Status und Allow-Header übernommen werden.
type discardWriter struct {
	header http.Header
	status int
}

func (d *discardWriter) Header() http.Header         { return d.header }
func (d *discardWriter) Write(b []byte) (int, error) { return len(b), nil }
func (d *discardWriter) WriteHeader(status int)      { d.status = status }

var logMethods = map[string]bool{
	http.MethodGet: true, http.MethodHead: true, http.MethodPost: true, http.MethodPut: true,
	http.MethodPatch: true, http.MethodDelete: true, http.MethodOptions: true,
	http.MethodConnect: true, http.MethodTrace: true,
}

func (rt *Router) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	id := AcceptOrGenerateRequestID(r.Header.Get("X-Request-Id"))
	ctx := context.WithValue(r.Context(), requestIDKey, id)
	ctx = context.WithValue(ctx, loggerKey, rt.logger)
	r = r.WithContext(ctx)

	h := w.Header()
	h.Set("X-Request-Id", id)
	h.Set("X-Content-Type-Options", "nosniff")
	// Downloads überschreiben das später mit "private, no-store".
	h.Set("Cache-Control", "no-store")

	rec := &recorder{ResponseWriter: w, status: http.StatusOK}
	_, pattern := rt.mux.Handler(r)
	route, matched := rt.routes[pattern]
	// ServeMux würde ungereinigte Pfade ("//", "/./") umleiten; wie bisher
	// gilt so ein Pfad als unbekannt.
	if matched && !isCleanPath(r.URL.Path) {
		matched = false
	}
	if !matched {
		route = "unmatched"
	}

	defer func() {
		v := recover()
		abort := false
		if v != nil {
			if v != http.ErrAbortHandler {
				rt.logger.LogAttrs(ctx, slog.LevelError, "Unbehandelte Ausnahme",
					slog.String("errorType", fmt.Sprintf("%T", v)),
					slog.Any("stack", panicStack()))
			}
			if rec.wroteHeader {
				// Antwort läuft bereits; Verbindung abbrechen.
				abort = true
			} else {
				WriteError(rec, r, Internal())
			}
		}
		rt.logAccess(ctx, r.Method, route, rec.status, started)
		if abort {
			panic(http.ErrAbortHandler)
		}
	}()

	if matched {
		rt.mux.ServeHTTP(rec, r)
		return
	}
	rt.unmatched(rec, r)
}

// unmatched beantwortet unbekannte Pfade mit 404 not-found und bekannte
// Pfade mit falscher Methode mit 405 method-not-allowed samt Allow-Header.
func (rt *Router) unmatched(w http.ResponseWriter, r *http.Request) {
	handler, _ := rt.mux.Handler(r)
	probe := &discardWriter{header: http.Header{}}
	handler.ServeHTTP(probe, r)
	if probe.status == http.StatusMethodNotAllowed {
		if allow := probe.header.Get("Allow"); allow != "" {
			w.Header().Set("Allow", allow)
		}
		WriteError(w, r, StatusError(http.StatusMethodNotAllowed))
		return
	}
	WriteError(w, r, StatusError(http.StatusNotFound))
}

func isCleanPath(p string) bool {
	if p == "" || p[0] != '/' {
		return false
	}
	c := path.Clean(p)
	if strings.HasSuffix(p, "/") && c != "/" {
		c += "/"
	}
	return c == p
}

func (rt *Router) logAccess(ctx context.Context, method, route string, status int, started time.Time) {
	if !logMethods[method] {
		method = "OTHER"
	}
	// Erfolgreiche Health-Abfragen (Container-Healthcheck) nur auf DEBUG.
	level := slog.LevelInfo
	if strings.HasPrefix(route, healthPrefix) && status < 400 {
		level = slog.LevelDebug
	}
	ms := math.Round(float64(time.Since(started).Microseconds())/100) / 10
	rt.logger.LogAttrs(ctx, level, "request",
		slog.String("method", method),
		slog.String("route", route),
		slog.Int("status", status),
		slog.Float64("durationMs", ms))
}

// panicStack beschreibt den Stack als "datei:zeile in funktion" – ohne
// Panic-Wert und ohne Argumentwerte (wie describe_exception in Python).
func panicStack() []string {
	pcs := make([]uintptr, 32)
	n := runtime.Callers(3, pcs)
	frames := runtime.CallersFrames(pcs[:n])
	var out []string
	for {
		f, more := frames.Next()
		out = append(out, fmt.Sprintf("%s:%d in %s", f.File, f.Line, f.Function))
		if !more {
			break
		}
	}
	return out
}
