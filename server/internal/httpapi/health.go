package httpapi

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"net/http"
	"os"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"miconverter/server/internal/apitypes"
)

// Namen der Readiness-Prüfungen (Vertrag §4). G02 implementiert storage;
// database, redis und capabilities registrieren G04, G05 und G07.
const (
	CheckDatabase     = "database"
	CheckRedis        = "redis"
	CheckStorage      = "storage"
	CheckCapabilities = "capabilities"
)

// Check prüft eine Abhängigkeit: nil = ok, Fehler = fail. Der Context endet
// nach dem Zeitlimit; Fehlertexte erscheinen weder in Antwort noch Log.
type Check func(ctx context.Context) error

// Readiness ist das Register der Prüfungen für GET /health/ready.
//
// Jede Prüfung läuft mit eigenem Zeitlimit. Je Prüfung gibt es höchstens
// einen laufenden Aufruf: Hängt ein Aufruf über das Zeitlimit hinaus (weil
// er den Context ignoriert), schlagen weitere Abfragen sofort fehl, statt
// jeweils eine neue Goroutine zu belegen (wie readiness.py).
type Readiness struct {
	timeout time.Duration
	logger  *slog.Logger

	mu     sync.RWMutex
	checks map[string]*checkEntry
}

type checkEntry struct {
	fn       Check
	inFlight atomic.Bool
}

// NewReadiness erzeugt ein leeres Register.
func NewReadiness(timeout time.Duration, logger *slog.Logger) *Readiness {
	if logger == nil {
		logger = slog.Default()
	}
	return &Readiness{timeout: timeout, logger: logger, checks: map[string]*checkEntry{}}
}

// Register fügt eine Prüfung hinzu; doppelte Namen sind ein Fehler.
func (rd *Readiness) Register(name string, fn Check) error {
	rd.mu.Lock()
	defer rd.mu.Unlock()
	if _, ok := rd.checks[name]; ok {
		return fmt.Errorf("Readiness-Prüfung %q ist bereits registriert", name)
	}
	rd.checks[name] = &checkEntry{fn: fn}
	return nil
}

// Names liefert die registrierten Namen sortiert.
func (rd *Readiness) Names() []string {
	rd.mu.RLock()
	defer rd.mu.RUnlock()
	return slices.Sorted(maps.Keys(rd.checks))
}

// Run führt alle Prüfungen parallel aus.
func (rd *Readiness) Run(ctx context.Context) map[string]apitypes.CheckStatus {
	rd.mu.RLock()
	entries := maps.Clone(rd.checks)
	rd.mu.RUnlock()

	results := make(map[string]apitypes.CheckStatus, len(entries))
	var mu sync.Mutex
	var wg sync.WaitGroup
	for name, e := range entries {
		wg.Go(func() {
			status := rd.runOne(ctx, name, e)
			mu.Lock()
			results[name] = status
			mu.Unlock()
		})
	}
	wg.Wait()
	return results
}

var errCheckPanic = errors.New("Prüfung abgestürzt")

func (rd *Readiness) runOne(ctx context.Context, name string, e *checkEntry) apitypes.CheckStatus {
	if !e.inFlight.CompareAndSwap(false, true) {
		rd.logger.LogAttrs(ctx, slog.LevelWarn, "Readiness-Prüfung hängt noch", slog.String("check", name))
		return apitypes.CheckFail
	}

	// Eigener Context: Die Prüfung soll auch nach einem Verbindungsabbruch
	// des Clients sauber enden und erst dann den Platz freigeben.
	checkCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), rd.timeout)
	done := make(chan error, 1)
	go func() {
		defer e.inFlight.Store(false)
		defer cancel()
		defer func() {
			if recover() != nil {
				done <- errCheckPanic
			}
		}()
		done <- e.fn(checkCtx)
	}()

	timer := time.NewTimer(rd.timeout)
	defer timer.Stop()
	select {
	case err := <-done:
		if err != nil {
			// Nur der Typ: Treibermeldungen enthalten Hostnamen und Ports.
			rd.logger.LogAttrs(ctx, slog.LevelWarn, "Readiness-Prüfung fehlgeschlagen",
				slog.String("check", name), slog.String("errorType", fmt.Sprintf("%T", err)))
			return apitypes.CheckFail
		}
		return apitypes.CheckOK
	case <-timer.C:
		rd.logger.LogAttrs(ctx, slog.LevelWarn, "Readiness-Prüfung überschritt Zeitlimit", slog.String("check", name))
		return apitypes.CheckFail
	case <-ctx.Done():
		return apitypes.CheckFail
	}
}

var errNotDirectory = errors.New("kein Verzeichnis")

// StorageCheck prüft, dass dir existiert und wirklich beschreibbar ist:
// Temp-Datei anlegen, schreiben, fsync, löschen (wie storage/checks.py;
// eine reine Rechteprüfung erkennt kein read-only-Volume und keinen vollen
// Datenträger).
func StorageCheck(dir string) Check {
	return func(context.Context) error {
		info, err := os.Stat(dir)
		if err != nil {
			return err
		}
		if !info.IsDir() {
			return errNotDirectory
		}
		f, err := os.CreateTemp(dir, ".ready-")
		if err != nil {
			return err
		}
		defer func() { _ = os.Remove(f.Name()) }()
		if _, err := f.Write([]byte("ok")); err != nil {
			_ = f.Close()
			return err
		}
		if err := f.Sync(); err != nil {
			_ = f.Close()
			return err
		}
		return f.Close()
	}
}

// RegisterHealth registriert GET /health/live und /health/ready.
func RegisterHealth(rt *Router, readiness *Readiness) {
	rt.HandleFunc(http.MethodGet, Prefix+"/health/live", func(w http.ResponseWriter, _ *http.Request) error {
		// Prüft keine Abhängigkeiten – nur, ob der Prozess antwortet.
		WriteJSON(w, http.StatusOK, apitypes.LiveResponse{Status: "ok"})
		return nil
	})
	rt.HandleFunc(http.MethodGet, Prefix+"/health/ready", func(w http.ResponseWriter, r *http.Request) error {
		checks := readiness.Run(r.Context())
		resp := apitypes.ReadyResponse{Status: apitypes.ReadyOK, Checks: checks}
		status := http.StatusOK
		for _, s := range checks {
			if s != apitypes.CheckOK {
				resp.Status, status = apitypes.ReadyUnavailable, http.StatusServiceUnavailable
				break
			}
		}
		WriteJSON(w, status, resp)
		return nil
	})
}

// New erzeugt den Router der API mit den Health-Endpunkten. Weitere Routen
// ergänzen spätere Arbeitspunkte über Handle/HandleFunc.
func New(logger *slog.Logger, readiness *Readiness) *Router {
	rt := NewRouter(logger)
	RegisterHealth(rt, readiness)
	return rt
}
