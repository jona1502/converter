package store_test

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"miconverter/server/internal/store"
	"miconverter/server/internal/testdb"
	"miconverter/server/migrations"
)

// Feste IDs für die Fixture; die letzte Ziffer benennt den Fall.
const (
	sessionID       = "00000000-0000-4000-8000-000000000000"
	jobQueuedBare   = "00000000-0000-4000-8000-00000000000a" // queued, kein Eintrag → neu
	jobQueuedOpen   = "00000000-0000-4000-8000-00000000000b" // queued, offener Eintrag → nichts
	jobQueuedTaken  = "00000000-0000-4000-8000-00000000000c" // queued, Eintrag verbraucht → neu
	jobQueuedGone   = "00000000-0000-4000-8000-00000000000d" // queued, gelöscht → nichts
	jobSucceeded    = "00000000-0000-4000-8000-00000000000e"
	jobRunning      = "00000000-0000-4000-8000-00000000000f"
	jobCancelled    = "00000000-0000-4000-8000-000000000010"
	jobFailed       = "00000000-0000-4000-8000-000000000011"
	jobExpiredState = "00000000-0000-4000-8000-000000000012"
)

func seedJobs(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", strings.Fields(sql)[0], err)
		}
	}
	exec(`INSERT INTO sessions (id, token_hash, expires_at)
	      VALUES ($1, decode(repeat('ab', 32), 'hex'), now() + interval '1 day')`, sessionID)
	job := func(id, state string, extra string) {
		t.Helper()
		exec(`INSERT INTO jobs (id, session_id, tool, state, options, input_name, input_size,
		        input_format, input_sha256, input_storage_key, max_attempts, expires_at,
		        lease_token, error_code, deleted_at)
		      VALUES ($1::uuid, $2::uuid, 'image-convert', $3::text, '{"targetFormat":"png"}', 'a.jpg', 10, 'jpeg',
		        decode(repeat('cd', 32), 'hex'), 'jobs/' || $1::uuid::text || '/input', 3,
		        now() + interval '1 hour',
		        CASE WHEN $3::text = 'running' THEN gen_random_uuid() END,
		        CASE WHEN $3::text = 'failed' THEN 'worker-failed' END,
		        CASE WHEN $4::text = 'deleted' THEN now() END)`, id, sessionID, state, extra)
	}
	job(jobQueuedBare, "queued", "")
	job(jobQueuedOpen, "queued", "")
	job(jobQueuedTaken, "queued", "")
	job(jobQueuedGone, "queued", "deleted")
	job(jobSucceeded, "succeeded", "")
	job(jobRunning, "running", "")
	job(jobCancelled, "cancelled", "")
	job(jobFailed, "failed", "")
	job(jobExpiredState, "expired", "")
	exec(`INSERT INTO outbox (kind, job_id) VALUES ('dispatch', $1)`, jobQueuedOpen)
	exec(`INSERT INTO outbox (kind, job_id, published_at) VALUES ('dispatch', $1, now())`, jobQueuedTaken)
	exec(`INSERT INTO outbox (kind, job_id, published_at) VALUES ('dispatch', $1, now())`, jobRunning)
	exec(`INSERT INTO job_results (id, job_id, ordinal, state, storage_key, size, mime, download_name)
	      VALUES (gen_random_uuid(), $1, 0, 'succeeded', 'jobs/x', 5, 'image/png', 'a.png')`, jobSucceeded)
}

// dataDump liefert den vollständigen Tabelleninhalt als vergleichbaren Text.
func dataDump(t *testing.T, ctx context.Context, pool *pgxpool.Pool) string {
	t.Helper()
	var b strings.Builder
	for _, table := range []string{"sessions", "jobs", "job_results", "outbox",
		"upload_reservations", "stale_attempts", "storage_usage"} {
		b.WriteString(table + "=" + tableDump(t, ctx, pool, table) + "\n")
	}
	return b.String()
}

func openDispatch(t *testing.T, ctx context.Context, pool *pgxpool.Pool) map[string]int {
	t.Helper()
	rows, err := pool.Query(ctx, `SELECT job_id::text, count(*) FROM outbox
		WHERE kind = 'dispatch' AND published_at IS NULL GROUP BY job_id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var id string
		var n int
		if err := rows.Scan(&id, &n); err != nil {
			t.Fatal(err)
		}
		out[id] = n
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestRequeueQueuesEachOpenJobOnce(t *testing.T) {
	ctx := testContext(t)
	pool, _ := testdb.NewPool(t)
	if _, err := store.Migrate(ctx, pool, migrations.FS); err != nil {
		t.Fatal(err)
	}
	seedJobs(t, ctx, pool)
	jobsBefore := tableDump(t, ctx, pool, "jobs")

	n, err := store.Requeue(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("Requeue = %d, erwartet 2", n)
	}
	open := openDispatch(t, ctx, pool)
	want := map[string]int{jobQueuedBare: 1, jobQueuedOpen: 1, jobQueuedTaken: 1}
	if len(open) != len(want) {
		t.Fatalf("offene Einträge = %v", open)
	}
	for id, cnt := range want {
		if open[id] != cnt {
			t.Fatalf("offene Einträge = %v", open)
		}
	}
	if tableDump(t, ctx, pool, "jobs") != jobsBefore {
		t.Fatal("Requeue darf Aufträge nicht verändern")
	}

	// Idempotent: zweiter Lauf legt nichts an.
	n, err = store.Requeue(ctx, pool)
	if err != nil || n != 0 {
		t.Fatalf("zweiter Lauf = %d, %v", n, err)
	}
}

func TestRequeueConcurrentRunsInsertOnce(t *testing.T) {
	ctx := testContext(t)
	pool, dsn := testdb.NewPool(t)
	if _, err := store.Migrate(ctx, pool, migrations.FS); err != nil {
		t.Fatal(err)
	}
	seedJobs(t, ctx, pool)
	other := testdb.Connect(t, dsn)

	counts := make(chan int64, 2)
	errs := make(chan error, 2)
	for _, p := range []*pgxpool.Pool{pool, other} {
		go func() {
			n, err := store.Requeue(ctx, p)
			counts <- n
			errs <- err
		}()
	}
	total := int64(0)
	for range 2 {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
		total += <-counts
	}
	if total != 2 {
		t.Fatalf("zusammen %d Einträge, erwartet 2", total)
	}
	for id, cnt := range openDispatch(t, ctx, pool) {
		if cnt != 1 {
			t.Fatalf("Auftrag %s hat %d offene Einträge", id, cnt)
		}
	}
}

func tableDump(t *testing.T, ctx context.Context, pool *pgxpool.Pool, table string) string {
	t.Helper()
	var rows string
	if err := pool.QueryRow(ctx,
		"SELECT coalesce(json_agg(x ORDER BY x::text), '[]')::text FROM "+table+" x").Scan(&rows); err != nil {
		t.Fatal(err)
	}
	return rows
}
