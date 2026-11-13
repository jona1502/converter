package jobs_test

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"miconverter/server/internal/jobs"
	"miconverter/server/internal/storage"
	"miconverter/server/internal/store"
	"miconverter/server/internal/testdb"
	"miconverter/server/migrations"
)

func defaultLimits() jobs.Limits {
	return jobs.Limits{
		ImageMaxInputBytes:   52_428_800,
		PDFMaxInputBytes:     100_000_000,
		AudioMaxInputBytes:   104_857_600,
		StorageBudgetBytes:   5_000_000_000,
		SessionMaxActiveJobs: 3,
		GlobalMaxActiveJobs:  50,
		UploadMax:            600 * time.Second,
		JobTTL:               time.Hour,
		JobMaxAttempts:       3,
	}
}

type env struct {
	ctx  context.Context
	pool *pgxpool.Pool
	dsn  string
	st   *storage.Local
	svc  *jobs.Service
}

func newEnv(t *testing.T, limits jobs.Limits) env {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
	t.Cleanup(cancel)
	pool, dsn := testdb.NewPool(t)
	if _, err := store.Migrate(ctx, pool, migrations.FS); err != nil {
		t.Fatal(err)
	}
	st, err := storage.NewLocal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	svc, err := jobs.New(pool, st, limits)
	if err != nil {
		t.Fatal(err)
	}
	jobs.SetFreeBytes(svc, func() (uint64, error) { return 1 << 50, nil })
	return env{ctx: ctx, pool: pool, dsn: dsn, st: st, svc: svc}
}

func (e env) session(t *testing.T) [16]byte {
	t.Helper()
	token := store.NewID()
	s, err := store.CreateSession(e.ctx, e.pool, sha256.Sum256(token[:]), 24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	return s.ID
}

func (e env) reserved(t *testing.T) (budget int64, reservations int) {
	t.Helper()
	if err := e.pool.QueryRow(e.ctx, `SELECT (SELECT reserved_bytes FROM storage_usage),
		(SELECT count(*) FROM upload_reservations)`).Scan(&budget, &reservations); err != nil {
		t.Fatal(err)
	}
	return
}

// spool schreibt den Upload in die Spooldatei der Reservierung.
func (e env) spool(t *testing.T, r jobs.Reservation, data []byte) {
	t.Helper()
	w, err := e.st.Create(r.SpoolKey)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
}

var pngOptions = json.RawMessage(`{"background":"#ffffff","format":"png","icoSizes":null,"quality":0.85,"resize":{"mode":"none"},"tool":"image-convert"}`)

func imageUpload(data []byte, options json.RawMessage) jobs.Upload {
	return jobs.Upload{
		Tool: "image-convert", Options: options, OriginalName: "Mein Foto.JPG",
		Size: int64(len(data)), SHA256: sha256.Sum256(data), InputFormat: "jpeg", OutputFormat: "png",
	}
}

func TestAdmitAndReleaseRestoreBudget(t *testing.T) {
	e := newEnv(t, defaultLimits())
	sess := e.session(t)
	r, err := e.svc.Admit(e.ctx, sess)
	if err != nil {
		t.Fatal(err)
	}
	// Audio ist mit 100 MiB die größte Eingabe und bestimmt die Reservierung.
	if r.Bytes != 104_857_600 || r.SpoolKey != storage.SpoolKey(r.ID) {
		t.Fatalf("Reservierung = %+v", r)
	}
	if b, n := e.reserved(t); b != r.Bytes || n != 1 {
		t.Fatalf("nach Admit: %d Bytes, %d Reservierungen", b, n)
	}
	e.spool(t, r, []byte("teil"))
	for range 2 { // idempotent
		if err := e.svc.Release(e.ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	if b, n := e.reserved(t); b != 0 || n != 0 {
		t.Fatalf("nach Release: %d Bytes, %d Reservierungen", b, n)
	}
	if ok, _ := e.st.Exists(r.SpoolKey); ok {
		t.Fatal("Spooldatei blieb")
	}
}

func TestReleaseWorksWithCancelledContext(t *testing.T) {
	e := newEnv(t, defaultLimits())
	r, err := e.svc.Admit(e.ctx, e.session(t))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(e.ctx)
	cancel()
	if err := e.svc.Release(ctx, r); err != nil {
		t.Fatal(err)
	}
	if b, n := e.reserved(t); b != 0 || n != 0 {
		t.Fatalf("nach Release: %d Bytes, %d Reservierungen", b, n)
	}
}

func TestAdmitLimits(t *testing.T) {
	limits := defaultLimits()
	limits.GlobalMaxActiveJobs = 4
	e := newEnv(t, limits)
	a, b := e.session(t), e.session(t)
	for range 3 {
		if _, err := e.svc.Admit(e.ctx, a); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := e.svc.Admit(e.ctx, a); !errors.Is(err, jobs.ErrSessionJobLimit) {
		t.Fatalf("Sitzungsgrenze: %v", err)
	}
	if _, err := e.svc.Admit(e.ctx, b); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.Admit(e.ctx, e.session(t)); !errors.Is(err, jobs.ErrServerBusy) {
		t.Fatalf("globale Grenze: %v", err)
	}
	var jerr *jobs.Error
	_, err := e.svc.Admit(e.ctx, e.session(t))
	if !errors.As(err, &jerr) || jerr.Status != 503 || jerr.RetryAfter != 5 || jerr.Code != "server-busy" {
		t.Fatalf("Fehlerabbildung: %#v", err)
	}
}

func TestAdmitCountsActiveJobsButNotExpiredOrDeleted(t *testing.T) {
	e := newEnv(t, defaultLimits())
	sess := e.session(t)
	// Zwei aktive Aufträge + ein abgelaufener + ein gelöschter.
	for i, extra := range []string{"", "", "expires_at = now() - interval '1 s'", "deleted_at = now()"} {
		r, err := e.svc.Admit(e.ctx, sess)
		if err != nil {
			t.Fatalf("%d: %v", i, err)
		}
		e.spool(t, r, []byte{byte(i)})
		acc, err := e.svc.Finalize(e.ctx, sess, r, imageUpload([]byte{byte(i)}, pngOptions), "")
		if err != nil {
			t.Fatal(err)
		}
		if extra != "" {
			if _, err := e.pool.Exec(e.ctx, "UPDATE jobs SET "+extra+" WHERE id = $1", acc.Job.Job.ID); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err := e.svc.Admit(e.ctx, sess); err != nil {
		t.Fatalf("dritter aktiver Platz: %v", err)
	}
	if _, err := e.svc.Admit(e.ctx, sess); !errors.Is(err, jobs.ErrSessionJobLimit) {
		t.Fatalf("Grenze: %v", err)
	}
}

func TestAdmitStorageFull(t *testing.T) {
	limits := defaultLimits()
	limits.StorageBudgetBytes = 150_000_000
	e := newEnv(t, limits)
	if _, err := e.svc.Admit(e.ctx, e.session(t)); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.Admit(e.ctx, e.session(t)); !errors.Is(err, jobs.ErrStorageFull) {
		t.Fatalf("Budget: %v", err)
	}
	jobs.SetFreeBytes(e.svc, func() (uint64, error) { return 104_857_599, nil })
	if _, err := e.svc.Admit(e.ctx, e.session(t)); !errors.Is(err, jobs.ErrStorageFull) {
		t.Fatalf("Dateisystem: %v", err)
	}
	if b, n := e.reserved(t); b != 104_857_600 || n != 1 {
		t.Fatalf("Fehlschläge haben reserviert: %d/%d", b, n)
	}
}

func TestParallelAdmitsRespectLimits(t *testing.T) {
	limits := defaultLimits()
	limits.GlobalMaxActiveJobs = 7
	e := newEnv(t, limits)
	same := e.session(t)
	sessions := make([][16]byte, 10)
	for i := range sessions {
		sessions[i] = e.session(t)
	}
	pools := []*pgxpool.Pool{e.pool, testdb.Connect(t, e.dsn), testdb.Connect(t, e.dsn)}

	var mu sync.Mutex
	okSame, okAll := 0, 0
	var wg sync.WaitGroup
	for i := range 20 {
		wg.Go(func() {
			svc, _ := jobs.New(pools[i%len(pools)], e.st, limits)
			jobs.SetFreeBytes(svc, func() (uint64, error) { return 1 << 50, nil })
			sess := same
			if i%2 == 1 {
				sess = sessions[i/2]
			}
			_, err := svc.Admit(e.ctx, sess)
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err == nil:
				okAll++
				if sess == same {
					okSame++
				}
			case errors.Is(err, jobs.ErrSessionJobLimit), errors.Is(err, jobs.ErrServerBusy):
			default:
				t.Error(err)
			}
		})
	}
	wg.Wait()
	if okSame > 3 || okAll != 7 {
		t.Fatalf("gleiche Sitzung %d (≤3), gesamt %d (=7)", okSame, okAll)
	}
	if b, n := e.reserved(t); n != 7 || b != 7*104_857_600 {
		t.Fatalf("Reservierungen %d, Bytes %d", n, b)
	}
}

func TestFinalizeCreatesQueuedJob(t *testing.T) {
	e := newEnv(t, defaultLimits())
	sess := e.session(t)
	r, err := e.svc.Admit(e.ctx, sess)
	if err != nil {
		t.Fatal(err)
	}
	data := []byte("jpeg-bytes")
	e.spool(t, r, data)
	acc, err := e.svc.Finalize(e.ctx, sess, r, imageUpload(data, pngOptions), "")
	if err != nil {
		t.Fatal(err)
	}
	j := acc.Job.Job
	if acc.Replayed || j.State != "queued" || j.InputName != "Mein Foto.JPG" || j.InputSize != int64(len(data)) ||
		j.ReservedBytes != int64(len(data)) || j.MaxAttempts != 3 || j.IdempotencyKey != nil || j.Fingerprint != nil {
		t.Fatalf("Auftrag = %+v", j)
	}
	var stored map[string]any
	if err := json.Unmarshal(j.Options, &stored); err != nil || stored["tool"] != "image-convert" || stored["quality"] != 0.85 {
		t.Fatalf("Optionen gespeichert als %s (%v)", j.Options, err)
	}
	if time.Until(j.ExpiresAt) < 59*time.Minute {
		t.Fatalf("Ablauf %v", j.ExpiresAt)
	}
	if len(acc.Job.Results) != 1 || acc.Job.Results[0].State != "pending" ||
		acc.Job.Results[0].DownloadName != "Mein Foto.png" || acc.Job.Results[0].MIME != "image/png" {
		t.Fatalf("Ergebnisse = %+v", acc.Job.Results)
	}
	var open int
	if err := e.pool.QueryRow(e.ctx, `SELECT count(*) FROM outbox WHERE job_id = $1 AND kind = 'dispatch'
		AND published_at IS NULL`, j.ID).Scan(&open); err != nil || open != 1 {
		t.Fatalf("Outbox = %d, %v", open, err)
	}
	path, _ := e.st.Path(storage.InputKey(j.ID))
	if got, err := os.ReadFile(path); err != nil || string(got) != string(data) {
		t.Fatalf("Eingabedatei = %q, %v", got, err)
	}
	if ok, _ := e.st.Exists(r.SpoolKey); ok {
		t.Fatal("Spooldatei blieb")
	}
	if b, n := e.reserved(t); b != int64(len(data)) || n != 0 {
		t.Fatalf("Budget %d, Reservierungen %d", b, n)
	}
}

func TestFinalizePDFCreatesResultPerLevel(t *testing.T) {
	e := newEnv(t, defaultLimits())
	sess := e.session(t)
	r, _ := e.svc.Admit(e.ctx, sess)
	data := []byte("%PDF-1.7")
	e.spool(t, r, data)
	acc, err := e.svc.Finalize(e.ctx, sess, r, jobs.Upload{
		Tool: "pdf-compress", Options: json.RawMessage(`{"levels":["small","high"],"tool":"pdf-compress"}`),
		OriginalName: "", Size: int64(len(data)), SHA256: sha256.Sum256(data), InputFormat: "pdf",
		PDFLevels: []string{"small", "high"},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	res := acc.Job.Results
	if acc.Job.Job.InputName != "dokument" || len(res) != 2 || *res[0].Level != "small" || *res[1].Level != "high" ||
		res[0].DownloadName != "dokument-small.pdf" || res[1].MIME != "application/pdf" {
		t.Fatalf("PDF-Auftrag = %+v %+v", acc.Job.Job, res)
	}
}

func TestFinalizeWithVanishedReservation(t *testing.T) {
	e := newEnv(t, defaultLimits())
	sess := e.session(t)
	r, _ := e.svc.Admit(e.ctx, sess)
	e.spool(t, r, []byte("x"))
	// Cleanup hat die Reservierung samt Bytes bereits entfernt.
	if _, err := e.pool.Exec(e.ctx, `WITH d AS (DELETE FROM upload_reservations RETURNING bytes)
		UPDATE storage_usage SET reserved_bytes = reserved_bytes - (SELECT sum(bytes) FROM d)`); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.Finalize(e.ctx, sess, r, imageUpload([]byte("x"), pngOptions), ""); !errors.Is(err, jobs.ErrReservationGone) {
		t.Fatalf("Finalize: %v", err)
	}
	if ok, _ := e.st.Exists(r.SpoolKey); ok {
		t.Fatal("Spooldatei blieb")
	}
	if b, n := e.reserved(t); b != 0 || n != 0 {
		t.Fatalf("Budget %d, Reservierungen %d (Doppelfreigabe?)", b, n)
	}
}

func TestFinalizeCommitFailureRemovesFileAndReservation(t *testing.T) {
	e := newEnv(t, defaultLimits())
	// Verzögerte Constraint-Prüfung: scheitert erst beim COMMIT.
	if _, err := e.pool.Exec(e.ctx, `
CREATE FUNCTION fail_commit() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN RAISE EXCEPTION 'commit verweigert'; END $$;
CREATE CONSTRAINT TRIGGER fail_commit AFTER INSERT ON outbox
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_commit();`); err != nil {
		t.Fatal(err)
	}
	sess := e.session(t)
	r, _ := e.svc.Admit(e.ctx, sess)
	data := []byte("data")
	e.spool(t, r, data)
	_, err := e.svc.Finalize(e.ctx, sess, r, imageUpload(data, pngOptions), "")
	if err == nil {
		t.Fatal("Commitfehler nicht gemeldet")
	}
	var jobsCount int
	_ = e.pool.QueryRow(e.ctx, "SELECT count(*) FROM jobs").Scan(&jobsCount)
	if jobsCount != 0 {
		t.Fatal("Auftrag trotz Commitfehler vorhanden")
	}
	entries, _ := os.ReadDir(e.st.Root() + "/jobs")
	if len(entries) != 0 {
		t.Fatalf("Eingabedateien blieben: %v", entries)
	}
	if ok, _ := e.st.Exists(r.SpoolKey); ok {
		t.Fatal("Spooldatei blieb")
	}
	if b, n := e.reserved(t); b != 0 || n != 0 {
		t.Fatalf("Budget %d, Reservierungen %d", b, n)
	}
}

func TestFinalizeCancelledContextCleansUp(t *testing.T) {
	e := newEnv(t, defaultLimits())
	sess := e.session(t)
	r, _ := e.svc.Admit(e.ctx, sess)
	e.spool(t, r, []byte("x"))
	ctx, cancel := context.WithCancel(e.ctx)
	cancel()
	if _, err := e.svc.Finalize(ctx, sess, r, imageUpload([]byte("x"), pngOptions), ""); err == nil {
		t.Fatal("abgebrochener Context ohne Fehler")
	}
	if b, n := e.reserved(t); b != 0 || n != 0 {
		t.Fatalf("Budget %d, Reservierungen %d", b, n)
	}
}

func finalizeWithKey(t *testing.T, e env, sess [16]byte, data []byte, options json.RawMessage, key string) (jobs.Acceptance, error) {
	t.Helper()
	r, err := e.svc.Admit(e.ctx, sess)
	if err != nil {
		t.Fatal(err)
	}
	e.spool(t, r, data)
	return e.svc.Finalize(e.ctx, sess, r, imageUpload(data, options), key)
}

func TestReplayAndConflict(t *testing.T) {
	e := newEnv(t, defaultLimits())
	sess := e.session(t)
	const key = "key-0123456789abcdef"
	data := []byte("same")

	if found, err := e.svc.LookupReplay(e.ctx, sess, key); found || err != nil {
		t.Fatalf("vor Annahme: %v, %v", found, err)
	}
	first, err := finalizeWithKey(t, e, sess, data, pngOptions, key)
	if err != nil {
		t.Fatal(err)
	}
	fp, _ := jobs.Fingerprint("image-convert", pngOptions, sha256.Sum256(data), int64(len(data)))
	if string(first.Job.Job.Fingerprint) != string(fp[:]) {
		t.Fatal("Fingerabdruck nicht gespeichert")
	}
	if found, err := e.svc.LookupReplay(e.ctx, sess, key); !found || err != nil {
		t.Fatalf("Lookup: %v, %v", found, err)
	}
	if found, _ := e.svc.LookupReplay(e.ctx, e.session(t), key); found {
		t.Fatal("Schlüssel nicht an Sitzung gebunden")
	}
	acc, err := e.svc.ResolveReplay(e.ctx, sess, key, fp)
	if err != nil || !acc.Replayed || acc.Job.Job.ID != first.Job.Job.ID {
		t.Fatalf("Replay = %+v, %v", acc, err)
	}
	other, _ := jobs.Fingerprint("image-convert", pngOptions, sha256.Sum256([]byte("anders")), 6)
	if _, err := e.svc.ResolveReplay(e.ctx, sess, key, other); !errors.Is(err, jobs.ErrIdempotencyConflict) {
		t.Fatalf("Konflikt: %v", err)
	}

	// Abgelaufen → 410, gelöscht → 404, jeweils schon beim Lookup.
	if _, err := e.pool.Exec(e.ctx, "UPDATE jobs SET expires_at = now() - interval '1 s'"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.LookupReplay(e.ctx, sess, key); !errors.Is(err, store.ErrJobExpired) {
		t.Fatalf("abgelaufen: %v", err)
	}
	if err := store.MarkDeleted(e.ctx, e.pool, sess, first.Job.Job.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.LookupReplay(e.ctx, sess, key); !errors.Is(err, store.ErrJobNotFound) {
		t.Fatalf("gelöscht: %v", err)
	}
	if _, err := e.svc.ResolveReplay(e.ctx, sess, key, fp); !errors.Is(err, store.ErrJobNotFound) {
		t.Fatalf("gelöscht (Resolve): %v", err)
	}
}

func TestConcurrentFinalizeSameKey(t *testing.T) {
	for _, sameBody := range []bool{true, false} {
		t.Run(map[bool]string{true: "gleich", false: "anders"}[sameBody], func(t *testing.T) {
			e := newEnv(t, defaultLimits())
			sess := e.session(t)
			const key = "parallel-key-0123456789"
			type outcome struct {
				acc jobs.Acceptance
				err error
			}
			results := make([]outcome, 2)
			reservations := make([]jobs.Reservation, 2)
			uploads := make([]jobs.Upload, 2)
			for i := range 2 {
				data := []byte("body")
				if !sameBody {
					data = []byte{byte('a' + i)}
				}
				r, err := e.svc.Admit(e.ctx, sess)
				if err != nil {
					t.Fatal(err)
				}
				e.spool(t, r, data)
				reservations[i], uploads[i] = r, imageUpload(data, pngOptions)
			}
			var start, wg sync.WaitGroup
			start.Add(1)
			for i := range 2 {
				wg.Go(func() {
					start.Wait()
					acc, err := e.svc.Finalize(e.ctx, sess, reservations[i], uploads[i], key)
					results[i] = outcome{acc, err}
				})
			}
			start.Done()
			wg.Wait()

			newCount, replays, conflicts := 0, 0, 0
			for _, r := range results {
				switch {
				case r.err == nil && !r.acc.Replayed:
					newCount++
				case r.err == nil && r.acc.Replayed:
					replays++
				case errors.Is(r.err, jobs.ErrIdempotencyConflict):
					conflicts++
				default:
					t.Fatal(r.err)
				}
			}
			if newCount != 1 || (sameBody && replays != 1) || (!sameBody && conflicts != 1) {
				t.Fatalf("neu %d, Replays %d, Konflikte %d", newCount, replays, conflicts)
			}
			var jobsCount int
			_ = e.pool.QueryRow(e.ctx, "SELECT count(*) FROM jobs").Scan(&jobsCount)
			b, n := e.reserved(t)
			if jobsCount != 1 || n != 0 || b != uploads[0].Size {
				t.Fatalf("Aufträge %d, Reservierungen %d, Budget %d", jobsCount, n, b)
			}
			for _, r := range reservations {
				if ok, _ := e.st.Exists(r.SpoolKey); ok {
					t.Fatal("Spooldatei blieb")
				}
			}
		})
	}
}

func TestFinalizeRejectsInvalidUpload(t *testing.T) {
	e := newEnv(t, defaultLimits())
	sess := e.session(t)
	r, _ := e.svc.Admit(e.ctx, sess)
	e.spool(t, r, []byte("x"))
	u := imageUpload([]byte("x"), pngOptions)
	u.OutputFormat = "gif"
	if _, err := e.svc.Finalize(e.ctx, sess, r, u, ""); err == nil {
		t.Fatal("ungültiges Zielformat akzeptiert")
	}
	if b, n := e.reserved(t); b != 0 || n != 0 {
		t.Fatalf("Budget %d, Reservierungen %d", b, n)
	}
}
