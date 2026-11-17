// Cleanup expires jobs and removes private files before releasing their budget.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"miconverter/server/internal/config"
	"miconverter/server/internal/jobs"
	"miconverter/server/internal/storage"
	"miconverter/server/internal/store"
)

func main() { os.Exit(run()) }
func run() int {
	cfg, err := config.FromEnv()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.SlogLevel()}))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	pool, err := store.Open(ctx, cfg.DatabaseURL.Reveal(), store.PoolOptions{MaxConns: int32(cfg.DatabasePoolSize), ApplicationName: "converter-cleanup"})
	if err != nil {
		logger.Error("database unavailable")
		return 1
	}
	defer pool.Close()
	st, err := storage.NewLocal(cfg.StorageDir)
	if err != nil {
		logger.Error("storage unavailable")
		return 1
	}
	cleaner := jobs.NewCleaner(pool, st, jobs.CleanupConfig{UploadMax: cfg.UploadMax, Runtime: jobs.RuntimeConfig{ImageTimeout: cfg.ImageTimeout, PDFTimeout: cfg.PdfTimeout, AudioTimeout: cfg.AudioTimeout, MarkdownTimeout: cfg.MarkdownTimeout}})
	ticker := time.NewTicker(cfg.CleanupInterval)
	defer ticker.Stop()
	for {
		if ctx.Err() != nil {
			return 0
		}
		checkCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		counts, err := cleaner.Once(checkCtx)
		cancel()
		if err != nil && ctx.Err() == nil {
			logger.Error("cleanup failed", "errorType", fmt.Sprintf("%T", err))
		} else if counts.Jobs+counts.Uploads+counts.StaleAttempts+counts.Orphans+counts.Sessions > 0 {
			logger.Info("cleanup complete", "jobs", counts.Jobs, "uploads", counts.Uploads, "staleAttempts", counts.StaleAttempts, "orphans", counts.Orphans, "sessions", counts.Sessions)
		}
		select {
		case <-ctx.Done():
			return 0
		case <-ticker.C:
		}
	}
}
