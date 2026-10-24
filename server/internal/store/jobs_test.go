package store_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"miconverter/server/internal/store"
	"miconverter/server/internal/testdb"
	"miconverter/server/migrations"
)

type fixture struct {
	ctx   context.Context
	pool  *pgxpool.Pool
	owner [16]byte
	other [16]byte
}

func newFixture(t *testing.T) fixture {
	t.Helper()
	ctx := testContext(t)
	pool, _ := testdb.NewPool(t)
	if _, err := store.Migrate(ctx, pool, migrations.FS); err != nil {
		t.Fatal(err)
	}
	f := fixture{ctx: ctx, pool: pool, owner: store.NewID(), other: store.NewID()}
	for _, id := range [][16]byte{f.owner, f.other} {
		if _, err := pool.Exec(ctx, `INSERT INTO sessions (id, token_hash, expires_at)
			VALUES ($1::uuid, sha256($1::uuid::text::bytea), now() + interval '1 day')`, id); err != nil {
			t.Fatal(err)
		}
	}
	return f
}

// job legt einen Auftrag an; extra wird als SET-Klausel nachgezogen.
func (f fixture) job(t *testing.T, session [16]byte, state, extra string) [16]byte {
	t.Helper()
	id := store.NewID()
	_, err := f.pool.Exec(f.ctx, `INSERT INTO jobs (id, session_id, tool, state, options, input_name,
		input_size, input_format, input_sha256, input_storage_key, max_attempts, expires_at,
		lease_token, error_code, phase)
		VALUES ($1::uuid, $2, 'pdf-compress', $3::text, '{"tool":"pdf-compress"}', 'a.pdf', 10, 'pdf',
		sha256('x'), 'jobs/' || $1::uuid::text || '/input', 3, now() + interval '1 hour',
		CASE WHEN $3::text = 'running' THEN gen_random_uuid() END,
		CASE WHEN $3::text = 'failed' THEN 'worker-failed' END,
		CASE WHEN $3::text = 'running' THEN 'variant' END)`, id, session, state)
	if err != nil {
		t.Fatal(err)
	}
	if extra != "" {
		if _, err := f.pool.Exec(f.ctx, "UPDATE jobs SET "+extra+" WHERE id = $1", id); err != nil {
			t.Fatal(err)
		}
	}
	return id
}

func (f fixture) result(t *testing.T, job [16]byte, ordinal int, state string) [16]byte {
	t.Helper()
	id := store.NewID()
	_, err := f.pool.Exec(f.ctx, `INSERT INTO job_results (id, job_id, ordinal, level, state, storage_key, size, mime, download_name)
		VALUES ($1, $2, $3, 'high', $4::text,
		CASE WHEN $4::text = 'succeeded' THEN 'jobs/x/results/y/z' END,
		CASE WHEN $4::text = 'succeeded' THEN 42 END, 'application/pdf', 'a-high.pdf')`, id, job, ordinal, state)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestLoadJobIsOwnerBound(t *testing.T) {
	f := newFixture(t)
	id := f.job(t, f.owner, "queued", "")
	f.result(t, id, 1, "pending")
	f.result(t, id, 0, "pending")

	loaded, err := store.LoadJob(f.ctx, f.pool, id, f.owner)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Job.ID != id || len(loaded.Results) != 2 || loaded.Results[0].Ordinal != 0 {
		t.Fatalf("geladen = %+v", loaded)
	}
	if string(loaded.Job.Options) != `{"tool": "pdf-compress"}` {
		t.Fatalf("Optionen = %s", loaded.Job.Options)
	}
	if _, err := store.LoadJob(f.ctx, f.pool, id, f.other); !errors.Is(err, store.ErrJobNotFound) {
		t.Fatalf("fremd: %v", err)
	}
	if _, err := store.LoadJob(f.ctx, f.pool, store.NewID(), f.owner); !errors.Is(err, store.ErrJobNotFound) {
		t.Fatalf("unbekannt: %v", err)
	}
	gone := f.job(t, f.owner, "succeeded", "deleted_at = now()")
	if _, err := store.LoadJob(f.ctx, f.pool, gone, f.owner); !errors.Is(err, store.ErrJobNotFound) {
		t.Fatalf("gelöscht: %v", err)
	}
}

func TestViewAppliesExpiryAndRunningRules(t *testing.T) {
	f := newFixture(t)
	running := f.job(t, f.owner, "running", `progress = '{"done":1}'`)
	r := f.result(t, running, 0, "succeeded")
	loaded, err := store.LoadJob(f.ctx, f.pool, running, f.owner)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	v := loaded.View(now)
	if v.State != "running" || v.Phase == nil || *v.Phase != "variant" || v.Progress == nil {
		t.Fatalf("running-Sicht = %+v", v)
	}
	if len(v.Results) != 1 || v.Results[0].ID != r || !v.Results[0].Downloadable {
		t.Fatalf("Ergebnis = %+v", v.Results)
	}
	// Nach Ablauf: expired, ohne Phase/Fortschritt/Downloads.
	v = loaded.View(loaded.Job.ExpiresAt)
	if v.State != "expired" || v.Phase != nil || v.Progress != nil || v.Results[0].Downloadable {
		t.Fatalf("abgelaufene Sicht = %+v", v)
	}
	expiredState := f.job(t, f.owner, "expired", "")
	loaded, _ = store.LoadJob(f.ctx, f.pool, expiredState, f.owner)
	if got := loaded.View(now).State; got != "expired" {
		t.Fatalf("Zustand = %s", got)
	}
	cancelReq := f.job(t, f.owner, "queued", "cancel_requested_at = now()")
	loaded, _ = store.LoadJob(f.ctx, f.pool, cancelReq, f.owner)
	if !loaded.View(now).CancelRequested {
		t.Fatal("cancelRequested fehlt")
	}
}

func TestCancelOutcomes(t *testing.T) {
	f := newFixture(t)
	queued := f.job(t, f.owner, "queued", "")
	pending := f.result(t, queued, 0, "pending")
	running := f.job(t, f.owner, "running", "")
	succeeded := f.job(t, f.owner, "succeeded", "")
	cancelled := f.job(t, f.owner, "cancelled", "")
	stale := f.job(t, f.owner, "queued", "expires_at = now() - interval '1 second'")

	cases := []struct {
		id   [16]byte
		want store.CancelOutcome
	}{
		{queued, store.CancelCompleted},
		{running, store.CancelRequested},
		{succeeded, store.CancelNotApplicable},
		{cancelled, store.CancelCompleted},
		{stale, store.CancelNotApplicable},
	}
	for _, c := range cases {
		got, loaded, err := store.Cancel(f.ctx, f.pool, f.owner, c.id)
		if err != nil || got != c.want {
			t.Fatalf("Cancel(%x) = %s, %v; erwartet %s", c.id, got, err, c.want)
		}
		if loaded.Job.ID != c.id {
			t.Fatal("falscher Auftrag zurückgegeben")
		}
	}
	loaded, _ := store.LoadJob(f.ctx, f.pool, queued, f.owner)
	if loaded.Job.State != "cancelled" || loaded.Job.FinishedAt == nil || loaded.Job.CancelRequestedAt == nil ||
		loaded.Job.Version != 1 || loaded.Results[0].ID != pending || loaded.Results[0].State != "cancelled" {
		t.Fatalf("queued nach Abbruch = %+v", loaded)
	}
	loaded, _ = store.LoadJob(f.ctx, f.pool, running, f.owner)
	if loaded.Job.State != "running" || loaded.Job.CancelRequestedAt == nil {
		t.Fatalf("running nach Abbruch = %+v", loaded.Job)
	}
	if _, _, err := store.Cancel(f.ctx, f.pool, f.other, running); !errors.Is(err, store.ErrJobNotFound) {
		t.Fatalf("fremder Abbruch: %v", err)
	}
}

func TestMarkDeleted(t *testing.T) {
	f := newFixture(t)
	queued := f.job(t, f.owner, "queued", "")
	done := f.job(t, f.owner, "succeeded", "")
	if err := store.MarkDeleted(f.ctx, f.pool, f.other, queued); !errors.Is(err, store.ErrJobNotFound) {
		t.Fatalf("fremd: %v", err)
	}
	for _, id := range [][16]byte{queued, done} {
		if err := store.MarkDeleted(f.ctx, f.pool, f.owner, id); err != nil {
			t.Fatal(err)
		}
		if err := store.MarkDeleted(f.ctx, f.pool, f.owner, id); !errors.Is(err, store.ErrJobNotFound) {
			t.Fatalf("zweites Löschen: %v", err)
		}
	}
	var cancelQueued, cancelDone bool
	var deletes int
	if err := f.pool.QueryRow(f.ctx, `SELECT
		(SELECT cancel_requested_at IS NOT NULL FROM jobs WHERE id = $1),
		(SELECT cancel_requested_at IS NOT NULL FROM jobs WHERE id = $2),
		(SELECT count(*) FROM outbox WHERE kind = 'delete' AND job_id IN ($1, $2))`, queued, done).
		Scan(&cancelQueued, &cancelDone, &deletes); err != nil {
		t.Fatal(err)
	}
	if !cancelQueued || cancelDone || deletes != 2 {
		t.Fatalf("cancel queued=%v done=%v, delete-Einträge=%d", cancelQueued, cancelDone, deletes)
	}
}

func TestLeaseDownload(t *testing.T) {
	f := newFixture(t)
	job := f.job(t, f.owner, "succeeded", "")
	ok := f.result(t, job, 0, "succeeded")
	pending := f.result(t, job, 1, "pending")
	const maxDur = 300 * time.Second

	d, err := store.LeaseDownload(f.ctx, f.pool, f.owner, job, ok, maxDur)
	if err != nil {
		t.Fatal(err)
	}
	if d.StorageKey != "jobs/x/results/y/z" || d.Size != 42 || d.MIME != "application/pdf" || d.DownloadName != "a-high.pdf" {
		t.Fatalf("Download = %+v", d)
	}
	var until time.Time
	if err := f.pool.QueryRow(f.ctx, "SELECT download_until FROM jobs WHERE id = $1", job).Scan(&until); err != nil {
		t.Fatal(err)
	}
	if !until.Equal(d.Deadline) || time.Until(until) < maxDur-time.Minute {
		t.Fatalf("download_until = %v, Deadline = %v", until, d.Deadline)
	}

	checks := []struct {
		name            string
		session, j, res [16]byte
		want            error
	}{
		{"fremd", f.other, job, ok, store.ErrJobNotFound},
		{"unbekannter Auftrag", f.owner, store.NewID(), ok, store.ErrJobNotFound},
		{"nicht fertig", f.owner, job, pending, store.ErrResultNotFound},
		{"unbekanntes Ergebnis", f.owner, job, store.NewID(), store.ErrResultNotFound},
	}
	for _, c := range checks {
		if _, err := store.LeaseDownload(f.ctx, f.pool, c.session, c.j, c.res, maxDur); !errors.Is(err, c.want) {
			t.Errorf("%s: %v", c.name, err)
		}
	}
	// Ergebnis eines anderen eigenen Auftrags unter falscher Auftrags-ID.
	other := f.job(t, f.owner, "succeeded", "")
	if _, err := store.LeaseDownload(f.ctx, f.pool, f.owner, other, ok, maxDur); !errors.Is(err, store.ErrResultNotFound) {
		t.Errorf("Ergebnis fremden Auftrags: %v", err)
	}

	expired := f.job(t, f.owner, "succeeded", "expires_at = now() - interval '1 second'")
	r := f.result(t, expired, 0, "succeeded")
	if _, err := store.LeaseDownload(f.ctx, f.pool, f.owner, expired, r, maxDur); !errors.Is(err, store.ErrJobExpired) {
		t.Errorf("abgelaufen: %v", err)
	}
	expiredState := f.job(t, f.owner, "expired", "")
	r = f.result(t, expiredState, 0, "succeeded")
	if _, err := store.LeaseDownload(f.ctx, f.pool, f.owner, expiredState, r, maxDur); !errors.Is(err, store.ErrJobExpired) {
		t.Errorf("Zustand expired: %v", err)
	}
	deleted := f.job(t, f.owner, "succeeded", "deleted_at = now()")
	r = f.result(t, deleted, 0, "succeeded")
	if _, err := store.LeaseDownload(f.ctx, f.pool, f.owner, deleted, r, maxDur); !errors.Is(err, store.ErrJobNotFound) {
		t.Errorf("gelöscht: %v", err)
	}
}
