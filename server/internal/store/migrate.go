package store

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"regexp"
	"slices"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// AlembicHeadRevision ist die Revision-ID von
// backend/migrations/versions/0003_stale_attempts.py. Nur auf diesem Stand
// wird eine bestehende Datenbank übernommen.
const AlembicHeadRevision = "0003"

// AlembicBaselineVersion ist die Go-Version, die AlembicHeadRevision entspricht.
const AlembicBaselineVersion = 3

// migrationLockKey ist der feste Schlüssel für pg_advisory_lock. Er gilt je
// Datenbank und darf sich nie ändern, sonst laufen alte und neue Runner
// gleichzeitig.
const migrationLockKey int64 = 0x6d69_636f_6e76_0001

// Migration ist eine eingebettete SQL-Datei.
type Migration struct {
	Version int
	Name    string
	SQL     string
}

// MigrateResult beschreibt, was ein Lauf geändert hat.
type MigrateResult struct {
	// Baselined: Versionen 1–3 wurden aus alembic_version übernommen, ohne SQL.
	Baselined bool
	// Applied: in diesem Lauf ausgeführte Versionen, aufsteigend.
	Applied []int
}

// Fehler, bei denen der Runner nichts verändert hat.
var (
	ErrAlembicRevision = errors.New("store: Alembic-Stand ist nicht " + AlembicHeadRevision + "; zuerst mit Alembic auf head migrieren")
	ErrUnknownSchema   = errors.New("store: Schema public enthält Tabellen ohne Versionsinformation")
	ErrSchemaTooNew    = errors.New("store: Datenbank enthält unbekannte Migrationsversionen (neuere Software?)")
)

var migrationName = regexp.MustCompile(`^([0-9]{4})_([a-z0-9_]+)\.sql$`)

// LoadMigrations liest alle NNNN_name.sql aus fsys. Versionen müssen lückenlos
// bei 1 beginnen.
func LoadMigrations(fsys fs.FS) ([]Migration, error) {
	entries, err := fs.ReadDir(fsys, ".")
	if err != nil {
		return nil, fmt.Errorf("store: Migrationen lesen: %w", err)
	}
	var out []Migration
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		m := migrationName.FindStringSubmatch(e.Name())
		if m == nil {
			continue
		}
		version, _ := strconv.Atoi(m[1])
		body, err := fs.ReadFile(fsys, e.Name())
		if err != nil {
			return nil, fmt.Errorf("store: Migration %s lesen: %w", e.Name(), err)
		}
		out = append(out, Migration{Version: version, Name: m[2], SQL: string(body)})
	}
	slices.SortFunc(out, func(a, b Migration) int { return a.Version - b.Version })
	for i, m := range out {
		if m.Version != i+1 {
			return nil, fmt.Errorf("store: Migrationsversionen nicht lückenlos (erwartet %d, gefunden %d)", i+1, m.Version)
		}
	}
	if len(out) < AlembicBaselineVersion {
		return nil, fmt.Errorf("store: mindestens %d Migrationen erwartet", AlembicBaselineVersion)
	}
	return out, nil
}

const createSchemaMigrations = `CREATE TABLE IF NOT EXISTS schema_migrations (
    version integer PRIMARY KEY,
    applied_at timestamp with time zone NOT NULL DEFAULT now()
)`

// Migrate bringt die Datenbank auf den Stand von fsys. Der ganze Lauf hält
// pg_advisory_lock; jede Migration läuft samt Versionseintrag in einer
// eigenen Transaktion. alembic_version bleibt unverändert (Rückweg).
func Migrate(ctx context.Context, pool *pgxpool.Pool, fsys fs.FS) (MigrateResult, error) {
	migrations, err := LoadMigrations(fsys)
	if err != nil {
		return MigrateResult{}, err
	}
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return MigrateResult{}, fmt.Errorf("store: Verbindung für Migration: %w", err)
	}
	defer conn.Release()

	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", migrationLockKey); err != nil {
		return MigrateResult{}, fmt.Errorf("store: Migrationssperre: %w", err)
	}
	defer func() {
		// Eigener Context: die Sperre muss auch nach Abbruch frei werden.
		unlockCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if _, err := conn.Exec(unlockCtx, "SELECT pg_advisory_unlock($1)", migrationLockKey); err != nil {
			// Verbindung schließen gibt die Sitzungssperre sicher frei.
			_ = conn.Conn().Close(unlockCtx)
		}
	}()

	var result MigrateResult
	applied, err := appliedVersions(ctx, conn.Conn())
	if err != nil {
		return result, err
	}
	if applied == nil {
		baselined, err := initialState(ctx, conn.Conn())
		if err != nil {
			return result, err
		}
		if baselined {
			if err := baseline(ctx, conn.Conn()); err != nil {
				return result, err
			}
			result.Baselined = true
			applied = make([]int, 0, AlembicBaselineVersion)
			for v := 1; v <= AlembicBaselineVersion; v++ {
				applied = append(applied, v)
			}
		}
	}

	known := make(map[int]bool, len(migrations))
	for _, m := range migrations {
		known[m.Version] = true
	}
	done := make(map[int]bool, len(applied))
	for _, v := range applied {
		if !known[v] {
			return result, ErrSchemaTooNew
		}
		done[v] = true
	}
	for _, m := range migrations {
		if done[m.Version] {
			continue
		}
		if err := applyMigration(ctx, conn.Conn(), m); err != nil {
			return result, err
		}
		result.Applied = append(result.Applied, m.Version)
	}
	return result, nil
}

// appliedVersions liefert nil, wenn schema_migrations noch nicht existiert.
func appliedVersions(ctx context.Context, conn *pgx.Conn) ([]int, error) {
	var exists bool
	if err := conn.QueryRow(ctx,
		"SELECT to_regclass('public.schema_migrations') IS NOT NULL").Scan(&exists); err != nil {
		return nil, fmt.Errorf("store: Versionstabelle prüfen: %w", err)
	}
	if !exists {
		return nil, nil
	}
	rows, err := conn.Query(ctx, "SELECT version FROM public.schema_migrations ORDER BY version")
	if err != nil {
		return nil, fmt.Errorf("store: Versionen lesen: %w", err)
	}
	versions, err := pgx.CollectRows(rows, pgx.RowTo[int])
	if err != nil {
		return nil, fmt.Errorf("store: Versionen lesen: %w", err)
	}
	if versions == nil {
		versions = []int{}
	}
	return versions, nil
}

// initialState entscheidet ohne schema_migrations: true = Alembic-Head
// übernehmen, false = leere Datenbank. Alles andere ist ein Fehler.
func initialState(ctx context.Context, conn *pgx.Conn) (bool, error) {
	var hasAlembic bool
	if err := conn.QueryRow(ctx,
		"SELECT to_regclass('public.alembic_version') IS NOT NULL").Scan(&hasAlembic); err != nil {
		return false, fmt.Errorf("store: Alembic-Stand prüfen: %w", err)
	}
	if hasAlembic {
		rows, err := conn.Query(ctx, "SELECT version_num::text FROM public.alembic_version")
		if err != nil {
			return false, fmt.Errorf("store: Alembic-Stand lesen: %w", err)
		}
		revisions, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return false, fmt.Errorf("store: Alembic-Stand lesen: %w", err)
		}
		if len(revisions) != 1 || revisions[0] != AlembicHeadRevision {
			return false, ErrAlembicRevision
		}
		return true, nil
	}
	var objects int
	if err := conn.QueryRow(ctx, `SELECT count(*) FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')`).Scan(&objects); err != nil {
		return false, fmt.Errorf("store: Schema prüfen: %w", err)
	}
	if objects > 0 {
		return false, ErrUnknownSchema
	}
	return false, nil
}

func baseline(ctx context.Context, conn *pgx.Conn) error {
	return pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, createSchemaMigrations); err != nil {
			return fmt.Errorf("store: Versionstabelle anlegen: %w", err)
		}
		if _, err := tx.Exec(ctx,
			"INSERT INTO schema_migrations (version) SELECT generate_series(1, $1::int)",
			AlembicBaselineVersion); err != nil {
			return fmt.Errorf("store: Alembic-Basis übernehmen: %w", err)
		}
		return nil
	})
}

func applyMigration(ctx context.Context, conn *pgx.Conn, m Migration) error {
	err := pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, createSchemaMigrations); err != nil {
			return err
		}
		// Einfaches Protokoll: mehrere Anweisungen in einer Datei sind erlaubt.
		if _, err := tx.Exec(ctx, m.SQL, pgx.QueryExecModeSimpleProtocol); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, "INSERT INTO schema_migrations (version) VALUES ($1)", m.Version)
		return err
	})
	if err != nil {
		return fmt.Errorf("store: Migration %04d_%s: %w", m.Version, m.Name, err)
	}
	return nil
}
