// Worker consumes the durable PostgreSQL queue and supervises private converters.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"miconverter/server/internal/config"
	"miconverter/server/internal/converter"
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
	pool, err := store.Open(ctx, cfg.DatabaseURL.Reveal(), store.PoolOptions{MaxConns: int32(cfg.DatabasePoolSize), ApplicationName: "converter-worker"})
	if err != nil {
		logger.Error("database unavailable", "errorType", fmt.Sprintf("%T", err))
		return 1
	}
	defer pool.Close()
	if err := store.Ping(ctx, pool, 5*time.Second); err != nil {
		logger.Error("database unavailable")
		return 1
	}
	st, err := storage.NewLocal(cfg.StorageDir)
	if err != nil {
		logger.Error("storage unavailable")
		return 1
	}
	rt := jobs.NewRuntime(pool, jobs.RuntimeConfig{ImageMaxOutputBytes: cfg.ImageMaxOutputBytes, PDFMaxResultsTotalBytes: cfg.PdfMaxResultsTotalBytes, AudioMaxOutputBytes: cfg.AudioMaxOutputBytes, MarkdownMaxOutputBytes: cfg.MarkdownMaxOutputBytes, StorageBudgetBytes: cfg.StorageBudgetBytes, ImageTimeout: cfg.ImageTimeout, PDFTimeout: cfg.PdfTimeout, AudioTimeout: cfg.AudioTimeout, MarkdownTimeout: cfg.MarkdownTimeout})
	runner := converter.NewRunner()
	processor := converter.NewProcessor(runner, cfg)
	worker := jobs.NewWorker(rt, st, processor, jobs.WorkerConfig{Logger: logger})
	worker.Background = func(ctx context.Context) {
		converter.PublishLoop(ctx, runner, filepath.Join(cfg.StorageDir, converter.ReportFile), logger)
	}
	if err := worker.Run(ctx); err != nil {
		logger.Error("worker failed", "errorType", fmt.Sprintf("%T", err))
		return 1
	}
	return 0
}
