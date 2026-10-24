package httpapi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"miconverter/server/internal/apitypes"
	"miconverter/server/internal/validation"
)

var uuidRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// syncBuffer: Logpuffer, der parallel beschrieben werden darf.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) lines(t *testing.T) []map[string]any {
	t.Helper()
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []map[string]any
	sc := bufio.NewScanner(bytes.NewReader(b.buf.Bytes()))
	for sc.Scan() {
		var m map[string]any
		if err := json.Unmarshal(sc.Bytes(), &m); err != nil {
			t.Fatalf("Logzeile ist kein JSON: %s", sc.Text())
		}
		out = append(out, m)
	}
	return out
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

type testAPI struct {
	router    *Router
	readiness *Readiness
	logs      *syncBuffer
	storage   string
}

func newTestAPI(t *testing.T) *testAPI {
	t.Helper()
	logs := &syncBuffer{}
	logger := NewLogger(logs, slog.LevelDebug)
	readiness := NewReadiness(500*time.Millisecond, logger)
	dir := t.TempDir()
	if err := readiness.Register(CheckStorage, StorageCheck(dir)); err != nil {
		t.Fatal(err)
	}
	rt := New(logger, readiness)

	// Testrouten für Fehlerpfade.
	rt.HandleFunc(http.MethodGet, Prefix+"/_test/busy", func(http.ResponseWriter, *http.Request) error {
		return NewError(http.StatusServiceUnavailable, apitypes.CodeServerBusy, "Annahmegrenze erreicht.").WithRetryAfter(12)
	})
	rt.HandleFunc(http.MethodGet, Prefix+"/_test/limited", func(http.ResponseWriter, *http.Request) error {
		return NewError(http.StatusTooManyRequests, apitypes.CodeRateLimited, "Zu viele Anfragen.").WithRetryAfter(3)
	})
	rt.HandleFunc(http.MethodGet, Prefix+"/_test/invalid-options", func(http.ResponseWriter, *http.Request) error {
		return NewError(http.StatusUnprocessableEntity, apitypes.CodeInvalidOptions, "Optionen ungültig.").
			WithFields(apitypes.FieldError{Path: "options.width", Code: "out-of-range"}).WithRetryAfter(9)
	})
	rt.HandleFunc(http.MethodGet, Prefix+"/_test/crash", func(http.ResponseWriter, *http.Request) error {
		panic("geheim: /srv/storage/jobs/abc password=hunter2")
	})
	rt.HandleFunc(http.MethodGet, Prefix+"/_test/plain-error", func(http.ResponseWriter, *http.Request) error {
		return errors.New("dial tcp db.internal:5432: password=hunter2")
	})
	rt.HandleFunc(http.MethodGet, Prefix+"/_test/stream-crash", func(w http.ResponseWriter, _ *http.Request) error {
		_, _ = w.Write([]byte("erster-teil"))
		panic("geheim nach Antwortbeginn")
	})
	rt.HandleFunc(http.MethodGet, Prefix+"/_test/download", func(w http.ResponseWriter, _ *http.Request) error {
		w.Header().Set("Cache-Control", "private, no-store")
		_, _ = w.Write([]byte("x"))
		return nil
	})
	rt.HandleFunc(http.MethodGet, Prefix+"/_test/http/{code}", func(_ http.ResponseWriter, r *http.Request) error {
		switch r.PathValue("code") {
		case "400":
			return StatusError(400)
		case "409":
			return StatusError(409)
		case "413":
			return StatusError(413)
		case "502":
			return StatusError(502)
		}
		return StatusError(503)
	})
	rt.HandleFunc(http.MethodPost, Prefix+"/_test/options", func(w http.ResponseWriter, r *http.Request) error {
		var o apitypes.JobOptions
		if err := validation.DecodeStrict(r.Body, validation.Limits{MaxBytes: 8 << 10, MaxDepth: 8}, "options", &o); err != nil {
			return InvalidRequest(err)
		}
		WriteJSON(w, http.StatusOK, o)
		return nil
	})
	return &testAPI{router: rt, readiness: readiness, logs: logs, storage: dir}
}

func (a *testAPI) do(method, path string, header map[string]string, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	for k, v := range header {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	a.router.ServeHTTP(rec, req)
	return rec
}

func decodeBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("Antwort ist kein JSON: %q", rec.Body.String())
	}
	return m
}

func assertEnvelope(t *testing.T, rec *httptest.ResponseRecorder, wantError string) {
	t.Helper()
	if body := decodeBody(t, rec); len(body) != 2 || body["requestId"] != rec.Header().Get("X-Request-Id") {
		t.Fatalf("Fehlerhülle falsch: %s", rec.Body.String())
	}
	// Rohtext statt Map: auch die Feldreihenfolge entspricht Python.
	var raw struct {
		Error json.RawMessage `json:"error"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &raw)
	if got := string(raw.Error); got != wantError {
		t.Fatalf("error = %s, erwartet %s", got, wantError)
	}
	if rec.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("Content-Type = %q", rec.Header().Get("Content-Type"))
	}
}

// --- Request-ID und Header ---------------------------------------------------

func TestValidRequestIDIsAdopted(t *testing.T) {
	a := newTestAPI(t)
	rec := a.do("GET", "/api/v1/health/live", map[string]string{"X-Request-Id": "proxy-1234-abcd"}, "")
	if got := rec.Header().Get("X-Request-Id"); got != "proxy-1234-abcd" {
		t.Fatalf("X-Request-Id = %q", got)
	}
}

func TestInvalidRequestIDIsReplaced(t *testing.T) {
	a := newTestAPI(t)
	for _, incoming := range []string{"short", strings.Repeat("a", 65), "abc_def_ghi", "abcdefgh\tx", "abcdefgh ijk", "ünicode-1234"} {
		rec := a.do("GET", "/api/v1/health/live", map[string]string{"X-Request-Id": incoming}, "")
		got := rec.Header().Get("X-Request-Id")
		if got == incoming || !uuidRe.MatchString(got) {
			t.Errorf("%q → %q", incoming, got)
		}
	}
	if got := AcceptOrGenerateRequestID(strings.Repeat("a", 64)); got != strings.Repeat("a", 64) {
		t.Error("64 Zeichen sind erlaubt")
	}
	if got := AcceptOrGenerateRequestID("abcdefgh"); got != "abcdefgh" {
		t.Error("8 Zeichen sind erlaubt")
	}
}

func TestRequestIDGeneratedWhenMissing(t *testing.T) {
	a := newTestAPI(t)
	first := a.do("GET", "/api/v1/health/live", nil, "").Header().Get("X-Request-Id")
	second := a.do("GET", "/api/v1/health/live", nil, "").Header().Get("X-Request-Id")
	if !uuidRe.MatchString(first) || first == second {
		t.Fatalf("IDs %q %q", first, second)
	}
}

func TestSecurityHeadersOnAllResponses(t *testing.T) {
	a := newTestAPI(t)
	for _, path := range []string{"/api/v1/health/live", "/api/v1/unknown", "/", "/api/v1/_test/crash", "/api/v1/_test/busy"} {
		rec := a.do("GET", path, nil, "")
		if rec.Header().Get("Cache-Control") != "no-store" || rec.Header().Get("X-Content-Type-Options") != "nosniff" || rec.Header().Get("X-Request-Id") == "" {
			t.Errorf("%s: Header fehlen: %v", path, rec.Header())
		}
	}
}

func TestExplicitCacheControlIsKept(t *testing.T) {
	a := newTestAPI(t)
	rec := a.do("GET", "/api/v1/_test/download", nil, "")
	if rec.Header().Get("Cache-Control") != "private, no-store" || rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("Header: %v", rec.Header())
	}
}

// --- Fehlerformat -----------------------------------------------------------

func TestUnknownRouteReturnsNotFound(t *testing.T) {
	a := newTestAPI(t)
	for _, path := range []string{"/api/v1/does-not-exist", "/", "/api/v1/health/live/", "/api/v1//health/live", "/api/v1/./health/live"} {
		rec := a.do("GET", path, nil, "")
		if rec.Code != 404 {
			t.Errorf("%s: Status %d", path, rec.Code)
			continue
		}
		assertEnvelope(t, rec, `{"code":"not-found","message":"Ressource nicht gefunden."}`)
	}
}

func TestWrongMethodReturnsMethodNotAllowed(t *testing.T) {
	a := newTestAPI(t)
	rec := a.do("POST", "/api/v1/health/live", nil, "")
	if rec.Code != 405 {
		t.Fatalf("Status %d", rec.Code)
	}
	assertEnvelope(t, rec, `{"code":"method-not-allowed","message":"Methode nicht erlaubt."}`)
	if allow := rec.Header().Get("Allow"); !strings.Contains(allow, "GET") {
		t.Fatalf("Allow = %q", allow)
	}
}

func TestHeadOnGetRoute(t *testing.T) {
	a := newTestAPI(t)
	if rec := a.do("HEAD", "/api/v1/health/live", nil, ""); rec.Code != 200 {
		t.Fatalf("HEAD Status %d", rec.Code)
	}
}

func TestAPIErrorWithRetryAfter(t *testing.T) {
	a := newTestAPI(t)
	rec := a.do("GET", "/api/v1/_test/busy", nil, "")
	if rec.Code != 503 || rec.Header().Get("Retry-After") != "12" {
		t.Fatalf("Status %d, Retry-After %q", rec.Code, rec.Header().Get("Retry-After"))
	}
	assertEnvelope(t, rec, `{"code":"server-busy","message":"Annahmegrenze erreicht.","retryAfterSeconds":12}`)

	rec = a.do("GET", "/api/v1/_test/limited", nil, "")
	if rec.Code != 429 || rec.Header().Get("Retry-After") != "3" {
		t.Fatalf("429: Status %d, Retry-After %q", rec.Code, rec.Header().Get("Retry-After"))
	}
}

func TestRetryAfterOnlyFor429And503(t *testing.T) {
	a := newTestAPI(t)
	rec := a.do("GET", "/api/v1/_test/invalid-options", nil, "")
	if rec.Code != 422 || rec.Header().Get("Retry-After") != "" {
		t.Fatalf("Status %d, Retry-After %q", rec.Code, rec.Header().Get("Retry-After"))
	}
	assertEnvelope(t, rec, `{"code":"invalid-options","message":"Optionen ungültig.","fields":[{"path":"options.width","code":"out-of-range"}]}`)
}

func TestHTTPStatusMapping(t *testing.T) {
	a := newTestAPI(t)
	cases := []struct {
		code       string
		wantStatus int
		wantCode   string
	}{
		{"400", 400, "invalid-request"},
		{"409", 409, "invalid-request"},
		{"413", 413, "file-too-large"},
		{"502", 500, "internal-error"},
		{"503", 503, "service-unavailable"},
	}
	for _, tc := range cases {
		rec := a.do("GET", "/api/v1/_test/http/"+tc.code, nil, "")
		body := decodeBody(t, rec)
		code := body["error"].(map[string]any)["code"]
		if rec.Code != tc.wantStatus || code != tc.wantCode {
			t.Errorf("%s → %d %v", tc.code, rec.Code, code)
		}
	}
	if e := ServiceUnavailable(); e.Status != 503 || *e.RetryAfter != 5 {
		t.Error("ServiceUnavailable muss Retry-After 5 tragen")
	}
}

func TestPanicReturnsInternalErrorWithoutDetails(t *testing.T) {
	a := newTestAPI(t)
	rec := a.do("GET", "/api/v1/_test/crash", nil, "")
	if rec.Code != 500 {
		t.Fatalf("Status %d", rec.Code)
	}
	id := rec.Header().Get("X-Request-Id")
	assertEnvelope(t, rec, `{"code":"internal-error","message":"Interner Fehler."}`)
	for _, leaked := range []string{"hunter2", "/srv/storage", "goroutine", "panic"} {
		if strings.Contains(rec.Body.String(), leaked) {
			t.Fatalf("Antwort enthält %q", leaked)
		}
	}
	logs := a.logs.String()
	if strings.Contains(logs, "hunter2") || strings.Contains(logs, "/srv/storage") {
		t.Fatalf("Log enthält Panic-Text: %s", logs)
	}
	var panicLine map[string]any
	for _, l := range a.logs.lines(t) {
		if l["message"] == "Unbehandelte Ausnahme" {
			panicLine = l
		}
	}
	if panicLine == nil || panicLine["level"] != "ERROR" || panicLine["requestId"] != id || panicLine["errorType"] != "string" {
		t.Fatalf("Panic-Logzeile falsch: %v", panicLine)
	}
	stack, _ := panicLine["stack"].([]any)
	found := false
	for _, f := range stack {
		found = found || strings.Contains(f.(string), "newTestAPI")
	}
	if !found {
		t.Fatalf("Stack ohne Handlerframe: %v", stack)
	}
}

func TestPlainErrorIsInternalAndLoggedByTypeOnly(t *testing.T) {
	a := newTestAPI(t)
	rec := a.do("GET", "/api/v1/_test/plain-error", nil, "")
	if rec.Code != 500 {
		t.Fatalf("Status %d", rec.Code)
	}
	if strings.Contains(rec.Body.String()+a.logs.String(), "hunter2") {
		t.Fatal("Fehlertext gelangt in Antwort oder Log")
	}
	if !strings.Contains(a.logs.String(), `"errorType":"*errors.errorString"`) {
		t.Fatalf("Fehlertyp nicht geloggt: %s", a.logs.String())
	}
}

func TestPanicAfterResponseStartAbortsConnection(t *testing.T) {
	a := newTestAPI(t)
	srv := httptest.NewServer(a.router)
	defer srv.Close()
	// Server meldet den Abbruch über seinen eigenen Log; hier stumm schalten.
	srv.Config.ErrorLog = nil

	resp, err := http.Get(srv.URL + "/api/v1/_test/stream-crash")
	if err == nil {
		_, err = io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode != 200 || resp.Header.Get("X-Request-Id") == "" {
			t.Fatalf("Status %d", resp.StatusCode)
		}
	}
	if err == nil {
		t.Fatal("abgebrochene Antwort erwartet")
	}
	if strings.Contains(a.logs.String(), "geheim") {
		t.Fatal("Panic-Text im Log")
	}
}

func TestStrictJSONErrorsInContractFormat(t *testing.T) {
	a := newTestAPI(t)
	rec := a.do("POST", "/api/v1/_test/options", nil, `{"tool":"image-convert","format":"png","quality":"top-secret","sneaky":1}`)
	if rec.Code != 422 {
		t.Fatalf("Status %d", rec.Code)
	}
	assertEnvelope(t, rec, `{"code":"invalid-request","message":"Anfrage ist ungültig.","fields":[{"path":"options.quality","code":"invalid-type"},{"path":"options","code":"unknown-field"}]}`)
	if strings.Contains(rec.Body.String(), "sneaky") || strings.Contains(rec.Body.String(), "top-secret") {
		t.Fatal("Eingabewerte in der Antwort")
	}
	rec = a.do("POST", "/api/v1/_test/options", nil, `{"tool":"image-convert","format":"png","quality":0}`)
	if rec.Code != 200 || rec.Body.String() != `{"tool":"image-convert","format":"png","quality":0}` {
		t.Fatalf("gültige Optionen: %d %s", rec.Code, rec.Body.String())
	}
}

func TestFieldErrorsAreLimitedInCountAndLength(t *testing.T) {
	var fields []apitypes.FieldError
	for i := range 50 {
		fields = append(fields, apitypes.FieldError{Path: fmt.Sprintf("%02d-%s", i, strings.Repeat("k", 500)), Code: "x"})
	}
	fields = append(fields, apitypes.FieldError{Path: "", Code: "missing"})
	got := limitFields(fields)
	if len(got) != MaxFieldErrors {
		t.Fatalf("%d Feldfehler", len(got))
	}
	for _, f := range got {
		if len([]rune(f.Path)) > MaxFieldPathLength {
			t.Fatal("Pfad zu lang")
		}
	}
	if got := limitFields([]apitypes.FieldError{{Path: "", Code: "missing"}}); got[0].Path != "body" {
		t.Fatal("leerer Pfad muss body heißen")
	}
}

// --- Zugriffslog ------------------------------------------------------------

func TestAccessLogIsStructuredAndOmitsSecrets(t *testing.T) {
	a := newTestAPI(t)
	req := httptest.NewRequest("GET", "/api/v1/health/live?name=Geheim.pdf", nil)
	req.Header.Set("X-Request-Id", "trace-abcdef12")
	req.Header.Set("X-CSRF-Token", "csrf-secret-value")
	req.AddCookie(&http.Cookie{Name: "converter_session", Value: "cookie-secret-value"})
	a.router.ServeHTTP(httptest.NewRecorder(), req)

	lines := a.logs.lines(t)
	if len(lines) != 1 {
		t.Fatalf("erwartet eine Logzeile, erhalten %d", len(lines))
	}
	l := lines[0]
	if l["requestId"] != "trace-abcdef12" || l["level"] != "DEBUG" || l["method"] != "GET" ||
		l["route"] != "/api/v1/health/live" || l["status"] != float64(200) || l["message"] != "request" {
		t.Fatalf("Logzeile: %v", l)
	}
	if _, ok := l["durationMs"].(float64); !ok {
		t.Fatalf("durationMs fehlt: %v", l)
	}
	if _, ok := l["ts"].(string); !ok {
		t.Fatalf("ts fehlt: %v", l)
	}
	for _, secret := range []string{"cookie-secret-value", "csrf-secret-value", "Geheim.pdf"} {
		if strings.Contains(a.logs.String(), secret) {
			t.Fatalf("%q im Log", secret)
		}
	}
}

func TestRouteTemplateIsLoggedInsteadOfRawPath(t *testing.T) {
	a := newTestAPI(t)
	a.do("GET", "/api/v1/_test/http/Urlaubsfoto-Anna", nil, "")
	a.do("GET", "/unmatched/Urlaubsfoto-Anna.jpg", nil, "")
	a.do("BREW", "/api/v1/health/live", nil, "")
	lines := a.logs.lines(t)
	routes := []string{}
	for _, l := range lines {
		if l["message"] == "request" {
			routes = append(routes, l["route"].(string)+" "+l["method"].(string)+" "+l["level"].(string))
		}
	}
	want := "/api/v1/_test/http/{code} GET INFO|unmatched GET INFO|unmatched OTHER INFO"
	if strings.Join(routes, "|") != want {
		t.Fatalf("Routen %v, erwartet %s", routes, want)
	}
	if strings.Contains(a.logs.String(), "Urlaubsfoto") {
		t.Fatal("Rohpfad im Log")
	}
}

func TestLoggerDropsUnknownFields(t *testing.T) {
	var buf bytes.Buffer
	logger := NewLogger(&buf, slog.LevelInfo)
	logger.Warn("msg", "cookie", "nope", "status", 201, slog.Group("headers", "authorization", "geheim"), "error", errors.New("pfad /srv"))
	var entry map[string]any
	if err := json.Unmarshal(buf.Bytes(), &entry); err != nil {
		t.Fatal(err)
	}
	if _, ok := entry["cookie"]; ok {
		t.Fatal("cookie im Log")
	}
	if entry["status"] != float64(201) || entry["level"] != "WARNING" || entry["message"] != "msg" {
		t.Fatalf("Logzeile: %v", entry)
	}
	if strings.Contains(buf.String(), "geheim") || strings.Contains(buf.String(), "/srv") {
		t.Fatalf("nicht erlaubte Felder im Log: %s", buf.String())
	}
}

// --- Health -------------------------------------------------------------------

func TestLiveReturnsOK(t *testing.T) {
	a := newTestAPI(t)
	rec := a.do("GET", "/api/v1/health/live", nil, "")
	if rec.Code != 200 || rec.Body.String() != `{"status":"ok"}` {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
}

func TestReadyReportsRegisteredChecks(t *testing.T) {
	a := newTestAPI(t)
	rec := a.do("GET", "/api/v1/health/ready", nil, "")
	if rec.Code != 200 || rec.Body.String() != `{"status":"ok","checks":{"storage":"ok"}}` {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	entries, _ := os.ReadDir(a.storage)
	if len(entries) != 0 {
		t.Fatal("Prüfdatei muss wieder gelöscht sein")
	}
}

func readyWithStorage(t *testing.T, dir string) *httptest.ResponseRecorder {
	t.Helper()
	readiness := NewReadiness(time.Second, NewLogger(io.Discard, slog.LevelInfo))
	_ = readiness.Register(CheckStorage, StorageCheck(dir))
	rec := httptest.NewRecorder()
	New(NewLogger(io.Discard, slog.LevelInfo), readiness).ServeHTTP(rec, httptest.NewRequest("GET", "/api/v1/health/ready", nil))
	return rec
}

func TestReadyIs503WhenStorageMissingOrFile(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "file")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{filepath.Join(dir, "missing"), file} {
		rec := readyWithStorage(t, p)
		if rec.Code != 503 || rec.Body.String() != `{"status":"unavailable","checks":{"storage":"fail"}}` {
			t.Errorf("%s: %d %s", p, rec.Code, rec.Body.String())
		}
	}
}

func TestReadyIs503WhenStorageReadOnly(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("Verzeichnisrechte greifen nur unter POSIX und nicht für root")
	}
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Chmod(dir, 0o700) }()
	if rec := readyWithStorage(t, dir); rec.Code != 503 {
		t.Fatalf("Status %d", rec.Code)
	}
}

func TestFailingCheckDoesNotLeakDetails(t *testing.T) {
	a := newTestAPI(t)
	_ = a.readiness.Register(CheckDatabase, func(context.Context) error {
		return errors.New("db.internal:5432 password=hunter2")
	})
	_ = a.readiness.Register(CheckCapabilities, func(context.Context) error { panic("kaputt hunter2") })
	rec := a.do("GET", "/api/v1/health/ready", nil, "")
	if rec.Code != 503 || rec.Body.String() != `{"status":"unavailable","checks":{"capabilities":"fail","database":"fail","storage":"ok"}}` {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String()+a.logs.String(), "hunter2") || strings.Contains(rec.Body.String()+a.logs.String(), "5432") {
		t.Fatal("Details der Prüfung sichtbar")
	}
	// Fehlgeschlagene Readiness wird auf INFO geloggt.
	for _, l := range a.logs.lines(t) {
		if l["message"] == "request" && l["level"] != "INFO" {
			t.Fatalf("Zugriffslog: %v", l)
		}
	}
}

func TestDuplicateCheckNameIsRejected(t *testing.T) {
	r := NewReadiness(time.Second, nil)
	if err := r.Register("storage", func(context.Context) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if err := r.Register("storage", func(context.Context) error { return nil }); err == nil || !strings.Contains(err.Error(), "bereits registriert") {
		t.Fatalf("erwartet Fehler, erhalten %v", err)
	}
	if strings.Join(r.Names(), ",") != "storage" {
		t.Fatal("Names falsch")
	}
}

func TestSlowCheckTimesOutAndRespectsContext(t *testing.T) {
	r := NewReadiness(50*time.Millisecond, NewLogger(io.Discard, slog.LevelInfo))
	cancelled := make(chan struct{})
	_ = r.Register(CheckRedis, func(ctx context.Context) error {
		<-ctx.Done()
		close(cancelled)
		return ctx.Err()
	})
	start := time.Now()
	if got := r.Run(context.Background()); got[CheckRedis] != apitypes.CheckFail {
		t.Fatalf("erwartet fail, erhalten %v", got)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatal("Zeitlimit greift nicht")
	}
	select {
	case <-cancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("Context der Prüfung wurde nicht beendet")
	}
}

func TestHangingCheckDoesNotStartMoreRuns(t *testing.T) {
	r := NewReadiness(50*time.Millisecond, NewLogger(io.Discard, slog.LevelInfo))
	release := make(chan struct{})
	var calls atomic.Int32
	_ = r.Register(CheckRedis, func(context.Context) error {
		calls.Add(1)
		<-release // ignoriert den Context absichtlich
		return nil
	})
	for range 3 {
		if got := r.Run(context.Background()); got[CheckRedis] != apitypes.CheckFail {
			t.Fatalf("erwartet fail, erhalten %v", got)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("erwartet einen hängenden Lauf, erhalten %d", calls.Load())
	}
	close(release)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if r.Run(context.Background())[CheckRedis] == apitypes.CheckOK {
			if calls.Load() < 2 {
				t.Fatal("neuer Lauf erwartet")
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("Prüfung erholt sich nicht nach Freigabe")
}

func TestClientDisconnectEndsWaitButNotCheck(t *testing.T) {
	r := NewReadiness(time.Second, NewLogger(io.Discard, slog.LevelInfo))
	finished := make(chan struct{})
	_ = r.Register(CheckRedis, func(ctx context.Context) error {
		time.Sleep(100 * time.Millisecond)
		if ctx.Err() != nil {
			t.Error("Prüfung darf nicht durch den Client abgebrochen werden")
		}
		close(finished)
		return nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if got := r.Run(ctx); got[CheckRedis] != apitypes.CheckFail {
		t.Fatalf("erwartet fail, erhalten %v", got)
	}
	<-finished
}
