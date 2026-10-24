// Befehl api: HTTP-API von MI converter (Port 8000 hinter Nginx).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"miconverter/server/internal/config"
	"miconverter/server/internal/httpapi"
)

// Servergrenzen. Bewusst kein globales Read-/WriteTimeout: Uploads bis
// 100 MB dürfen bis UPLOAD_MAX_SECONDS (600 s) dauern, Downloads begrenzt
// der Handler selbst per http.ResponseController-Deadline.
const (
	readHeaderTimeout = 10 * time.Second
	idleTimeout       = 120 * time.Second
	maxHeaderBytes    = 64 << 10
	// Unter dem Docker-Standard von 10 s bis SIGKILL.
	shutdownTimeout = 8 * time.Second
)

var errNotImplemented = errors.New("Prüfung noch nicht implementiert")

func main() {
	os.Exit(run())
}

func run() int {
	addr := flag.String("addr", ":8000", "Listen-Adresse")
	flag.Parse()

	cfg, err := config.FromEnv()
	if err != nil {
		// Konfigurationsfehler nennen nur Variablennamen, nie Werte.
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	logger := httpapi.NewLogger(os.Stdout, cfg.SlogLevel())
	slog.SetDefault(logger)

	readiness := httpapi.NewReadiness(cfg.HealthCheckTimeout, logger)
	registerChecks(cfg, readiness)

	srv := &http.Server{
		Addr:              *addr,
		Handler:           httpapi.New(logger, readiness),
		ReadHeaderTimeout: readHeaderTimeout,
		IdleTimeout:       idleTimeout,
		MaxHeaderBytes:    maxHeaderBytes,
		// Meldungen von net/http enthalten Client-Adressen; nur ein fester Text.
		ErrorLog: log.New(serverErrorWriter{logger}, "", 0),
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.ListenAndServe() }()
	logger.Info("API gestartet")

	select {
	case err := <-serveErr:
		logger.Error("HTTP-Server beendet", "errorType", fmt.Sprintf("%T", err))
		return 1
	case <-ctx.Done():
	}

	logger.Info("API wird beendet")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		// Laufende Uploads/Downloads nach Fristablauf hart beenden.
		logger.Warn("Laufende Anfragen beim Beenden abgebrochen", "errorType", fmt.Sprintf("%T", err))
		_ = srv.Close()
	}
	return 0
}

// registerChecks registriert die Readiness-Prüfungen unter denselben
// Bedingungen wie backend/app/factory.py. Solange database (G04), redis
// (G05) und capabilities (G07) noch nicht in Go umgesetzt sind, melden sie
// ehrlich "fail" statt eine Bereitschaft vorzutäuschen.
func registerChecks(cfg *config.Config, readiness *httpapi.Readiness) {
	notImplemented := func(context.Context) error { return errNotImplemented }
	must := func(err error) {
		if err != nil {
			panic(err) // doppelte Registrierung ist ein Programmierfehler
		}
	}
	must(readiness.Register(httpapi.CheckStorage, httpapi.StorageCheck(cfg.StorageDir)))
	if cfg.DatabaseURL.IsSet() {
		must(readiness.Register(httpapi.CheckDatabase, notImplemented))
	}
	if cfg.RedisURL.IsSet() || cfg.Environment != config.Test {
		must(readiness.Register(httpapi.CheckRedis, notImplemented))
	}
	must(readiness.Register(httpapi.CheckCapabilities, notImplemented))
}

type serverErrorWriter struct{ logger *slog.Logger }

func (w serverErrorWriter) Write(p []byte) (int, error) {
	w.logger.Warn("HTTP-Serverfehler")
	return len(p), nil
}
