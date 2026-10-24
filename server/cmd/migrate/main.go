// Befehl migrate: Schema anlegen bzw. übernehmen und Queue beim Cutover
// übernehmen (docs/go-backend/architecture.md Abschnitt 6).
//
//	migrate up        Migrationen anwenden; Alembic-Stand 0003 wird übernommen
//	migrate requeue   queued-Aufträgen ohne offenen Dispatch-Eintrag einen geben
//
// Die Datenbank-URL kommt aus CONVERTER_DATABASE_URL (auch im
// SQLAlchemy-Format postgresql+psycopg://). Sie erscheint nie in Logs.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"miconverter/server/internal/store"
	"miconverter/server/migrations"
)

const envDatabaseURL = "CONVERTER_DATABASE_URL"

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := run(ctx, os.Args[1:], os.Getenv, os.Stderr)
	stop()
	os.Exit(code)
}

func usage(w io.Writer) {
	fmt.Fprintln(w, "Aufruf: migrate [-timeout 5m] up|requeue")
}

// run liefert den Exitcode: 0 Erfolg, 1 Fehler, 2 falscher Aufruf.
func run(ctx context.Context, args []string, getenv func(string) string, stderr io.Writer) int {
	log := slog.New(slog.NewJSONHandler(stderr, nil)).With("cmd", "migrate")

	flags := flag.NewFlagSet("migrate", flag.ContinueOnError)
	flags.SetOutput(stderr)
	timeout := flags.Duration("timeout", 5*time.Minute, "Obergrenze für den gesamten Lauf")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if flags.NArg() != 1 || *timeout <= 0 {
		usage(stderr)
		return 2
	}
	command := flags.Arg(0)
	if command != "up" && command != "requeue" {
		usage(stderr)
		return 2
	}

	dsn := getenv(envDatabaseURL)
	if dsn == "" {
		log.Error("Datenbank-URL fehlt", "env", envDatabaseURL)
		return 1
	}

	ctx, cancel := context.WithTimeout(ctx, *timeout)
	defer cancel()

	pool, err := store.Open(ctx, dsn, store.PoolOptions{MaxConns: 2, ApplicationName: "converter-migrate"})
	if err != nil {
		log.Error("Datenbank öffnen fehlgeschlagen", "error", err)
		return 1
	}
	defer pool.Close()
	if err := store.Ping(ctx, pool, 10*time.Second); err != nil {
		log.Error("Datenbank nicht erreichbar", "error", err)
		return 1
	}

	switch command {
	case "up":
		res, err := store.Migrate(ctx, pool, migrations.FS)
		if err != nil {
			log.Error("Migration fehlgeschlagen", "error", err, "timeout", errors.Is(err, context.DeadlineExceeded))
			return 1
		}
		log.Info("Migration abgeschlossen", "baselined", res.Baselined, "applied", res.Applied)
	case "requeue":
		n, err := store.Requeue(ctx, pool)
		if err != nil {
			log.Error("Requeue fehlgeschlagen", "error", err)
			return 1
		}
		log.Info("Requeue abgeschlossen", "queued", n)
	}
	return 0
}
