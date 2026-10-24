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
	"path/filepath"
	"syscall"
	"time"

	"miconverter/server/internal/config"
	"miconverter/server/internal/converter"
	"miconverter/server/internal/httpapi"
	"miconverter/server/internal/httpapi/endpoints"
	"miconverter/server/internal/ratelimit"
	"miconverter/server/internal/storage"
	"miconverter/server/internal/store"
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
	router := httpapi.New(logger, readiness)
	if cfg.DatabaseURL.IsSet() {
		pool, err := store.Open(context.Background(), cfg.DatabaseURL.Reveal(), store.PoolOptions{MaxConns: int32(cfg.DatabasePoolSize * 2)})
		if err != nil {
			logger.Error("Datenbankkonfiguration ungültig")
			return 2
		}
		defer pool.Close()
		files, err := storage.NewLocal(cfg.StorageDir)
		if err != nil {
			logger.Error("Dateispeicher nicht verfügbar")
			return 2
		}
		var limiter *ratelimit.Limiter
		if cfg.RedisURL.IsSet() {
			client, err := ratelimit.NewClient(cfg.RedisURL.Reveal())
			if err != nil {
				logger.Error("Brokerkonfiguration ungültig")
				return 2
			}
			defer client.Close()
			limiter = ratelimit.New(client)
		}
		api, err := endpoints.New(cfg, pool, files, limiter)
		if err != nil {
			logger.Error("API-Konfiguration ungültig")
			return 2
		}
		api.Register(router)
	}

	srv := &http.Server{
		Addr:              *addr,
		Handler:           router,
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
		must(readiness.Register(httpapi.CheckDatabase, func(ctx context.Context) error {
			pool, err := store.Open(ctx, cfg.DatabaseURL.Reveal(), store.PoolOptions{MaxConns: 1})
			if err != nil {
				return err
			}
			defer pool.Close()
			return pool.Ping(ctx)
		}))
	}
	if cfg.RedisURL.IsSet() || cfg.Environment != config.Test {
		check := notImplemented
		if cfg.RedisURL.IsSet() {
			check = func(ctx context.Context) error {
				client, err := ratelimit.NewClient(cfg.RedisURL.Reveal())
				if err != nil {
					return err
				}
				defer client.Close()
				return client.Ping(ctx).Err()
			}
		}
		must(readiness.Register(httpapi.CheckRedis, check))
	}
	must(readiness.Register(httpapi.CheckCapabilities, func(ctx context.Context) error {
		_, err := converter.LoadReport(filepath.Join(cfg.StorageDir, converter.ReportFile), time.Now().UTC(), 15*time.Minute)
		return err
	}))
}

type serverErrorWriter struct{ logger *slog.Logger }

func (w serverErrorWriter) Write(p []byte) (int, error) {
	w.logger.Warn("HTTP-Serverfehler")
	return len(p), nil
}
