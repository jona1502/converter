package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// requeueLockKey serialisiert parallele Requeue-Läufe; sonst sähen beide
// dieselben Aufträge ohne offenen Eintrag und legten zwei an.
const requeueLockKey int64 = 0x6d69_636f_6e76_0002

// Requeue gibt jedem nicht gelöschten queued-Auftrag ohne offenen
// Dispatch-Eintrag genau einen neuen Outbox-Eintrag (Cutover Schritt 5,
// docs/go-backend/architecture.md Abschnitt 6). Eine Transaktion, idempotent.
// Sonst wird nichts an Aufträgen verändert. Rückgabe: Anzahl neuer Einträge.
func Requeue(ctx context.Context, pool *pgxpool.Pool) (int64, error) {
	var inserted int64
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", requeueLockKey); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `
INSERT INTO outbox (kind, job_id)
SELECT 'dispatch', j.id
  FROM jobs j
 WHERE j.state = 'queued'
   AND j.deleted_at IS NULL
   AND NOT EXISTS (
         SELECT 1 FROM outbox o
          WHERE o.job_id = j.id AND o.kind = 'dispatch' AND o.published_at IS NULL)
 ORDER BY j.accepted_at, j.id`)
		if err != nil {
			return err
		}
		inserted = tag.RowsAffected()
		return nil
	})
	if err != nil {
		return 0, fmt.Errorf("store: Requeue: %w", err)
	}
	return inserted, nil
}
