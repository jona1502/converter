package jobs_test

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"miconverter/server/internal/jobs"
	"miconverter/server/internal/storage"
	"miconverter/server/internal/store"
)

func TestFinalizeLostCommitReplyDoesNotDeleteAcceptedInput(t *testing.T) {
	e := newEnv(t, defaultLimits())
	owner := e.session(t)
	r, err := e.svc.Admit(e.ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	data := []byte("committed input")
	e.spool(t, r, data)
	jobs.SetFinalizeTx(e.svc, func(ctx context.Context, fn func(pgx.Tx) error) error {
		if err := pgx.BeginFunc(ctx, e.pool, fn); err != nil {
			return err
		}
		return errors.New("simulated lost commit response")
	})
	accepted, err := e.svc.Finalize(e.ctx, owner, r, imageUpload(data, pngOptions), "")
	if err != nil {
		t.Fatal(err)
	}
	if accepted.Job.Job.ID != r.ID {
		t.Fatal("job/reservation ownership mismatch")
	}
	if exists, _ := e.st.Exists(storage.InputKey(r.ID)); !exists {
		t.Fatal("accepted input deleted")
	}
	if budget, reservations := e.reserved(t); budget != int64(len(data)) || reservations != 0 {
		t.Fatalf("budget %d reservations %d", budget, reservations)
	}
}

func TestCleanupUncertainPromotionBeforeBudgetRelease(t *testing.T) {
	e := newEnv(t, defaultLimits())
	owner := e.session(t)
	r, err := e.svc.Admit(e.ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	e.spool(t, r, []byte("promoted but no accepted job"))
	if err := e.st.Promote(r.SpoolKey, storage.InputKey(r.ID)); err != nil {
		t.Fatal(err)
	}
	if _, err := e.pool.Exec(e.ctx, `UPDATE upload_reservations SET expires_at=now()-interval '20 seconds'`); err != nil {
		t.Fatal(err)
	}
	counts, err := jobs.NewCleaner(e.pool, e.st, jobs.CleanupConfig{}).Once(e.ctx)
	if err != nil || counts.Uploads != 1 {
		t.Fatalf("cleanup %+v %v", counts, err)
	}
	if exists, _ := e.st.Exists(storage.InputKey(r.ID)); exists {
		t.Fatal("promoted orphan remains")
	}
	if budget, _ := e.reserved(t); budget != 0 {
		t.Fatal("budget not released")
	}
}

func newJob(t *testing.T, e env) ([16]byte, [16]byte) {
	t.Helper()
	owner := e.session(t)
	r, err := e.svc.Admit(e.ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	data := []byte("private input")
	e.spool(t, r, data)
	acc, err := e.svc.Finalize(e.ctx, owner, r, imageUpload(data, pngOptions), "")
	if err != nil {
		t.Fatal(err)
	}
	return owner, acc.Job.Job.ID
}

func writeResult(t *testing.T, e env, key string, data []byte) {
	t.Helper()
	w, err := e.st.Create(key)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = w.Write(data); err != nil {
		t.Fatal(err)
	}
	if err = w.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestConcurrentQueueClaimAndRecoveryReservation(t *testing.T) {
	e := newEnv(t, defaultLimits())
	_, id := newJob(t, e)
	rt := jobs.NewRuntime(e.pool, jobs.RuntimeConfig{})
	var wg sync.WaitGroup
	claims := make(chan *jobs.Task, 2)
	for range 2 {
		wg.Go(func() {
			task, _, err := rt.ClaimNext(e.ctx)
			if err != nil {
				t.Error(err)
			}
			claims <- task
		})
	}
	wg.Wait()
	close(claims)
	var task *jobs.Task
	count := 0
	for v := range claims {
		if v != nil {
			task = v
			count++
		}
	}
	if count != 1 || task.JobID != id {
		t.Fatalf("claims=%d", count)
	}
	if task.OutputBudget != 104_857_600 {
		t.Fatalf("budget=%d", task.OutputBudget)
	}
	writeResult(t, e, task.Results[0].Key, []byte("unfinished"))
	before, _ := e.reserved(t)
	if _, err := e.pool.Exec(e.ctx, `UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	if n, err := rt.Recover(e.ctx); err != nil || n != 1 {
		t.Fatalf("recover=%d,%v", n, err)
	}
	if ok, err := rt.Heartbeat(e.ctx, task); err != nil || ok {
		t.Fatalf("stale heartbeat=%v,%v", ok, err)
	}
	if after, _ := e.reserved(t); after != before {
		t.Fatalf("budget released while file lives: %d != %d", after, before)
	}
	cleaner := jobs.NewCleaner(e.pool, e.st, jobs.CleanupConfig{})
	if _, err := cleaner.Once(e.ctx); err != nil {
		t.Fatal(err)
	}
	if exists, _ := e.st.Exists(task.Results[0].Key); !exists {
		t.Fatal("protected stale file removed")
	}
	if _, err := e.pool.Exec(e.ctx, `UPDATE stale_attempts SET reap_after=now()-interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	counts, err := cleaner.Once(e.ctx)
	if err != nil || counts.StaleAttempts != 1 {
		t.Fatalf("cleanup=%+v,%v", counts, err)
	}
	if exists, _ := e.st.Exists(task.Results[0].Key); exists {
		t.Fatal("stale file remains")
	}
	if after, _ := e.reserved(t); after != before-task.OutputBudget {
		t.Fatalf("wrong budget: %d", after)
	}
}

func TestCleanupRunningExpiryAndDeletionRetainCrashBytes(t *testing.T) {
	for _, kind := range []string{"expired", "deleted"} {
		t.Run(kind, func(t *testing.T) {
			e := newEnv(t, defaultLimits())
			owner, id := newJob(t, e)
			rt := jobs.NewRuntime(e.pool, jobs.RuntimeConfig{})
			task, _, err := rt.ClaimNext(e.ctx)
			if err != nil || task == nil {
				t.Fatal(err)
			}
			writeResult(t, e, task.Results[0].Key, []byte("unfinished"))
			before, _ := e.reserved(t)
			if kind == "deleted" {
				if err := store.MarkDeleted(e.ctx, e.pool, owner, id); err != nil {
					t.Fatal(err)
				}
			} else {
				if _, err := e.pool.Exec(e.ctx, `UPDATE jobs SET expires_at=now()-interval '1 second' WHERE id=$1`, id); err != nil {
					t.Fatal(err)
				}
			}
			cleaner := jobs.NewCleaner(e.pool, e.st, jobs.CleanupConfig{})
			if _, err := cleaner.Once(e.ctx); err != nil {
				t.Fatal(err)
			}
			if after, _ := e.reserved(t); after != before {
				t.Fatal("released active output budget")
			}
			if exists, _ := e.st.Exists(task.Results[0].Key); !exists {
				t.Fatal("active output disappeared")
			}
			if _, err := e.pool.Exec(e.ctx, `UPDATE stale_attempts SET reap_after=now()-interval '1 second'`); err != nil {
				t.Fatal(err)
			}
			if counts, err := cleaner.Once(e.ctx); err != nil || counts.Jobs != 1 {
				t.Fatalf("cleanup=%+v,%v", counts, err)
			}
			if after, _ := e.reserved(t); after != 0 {
				t.Fatalf("reservation remains: %d", after)
			}
			if _, err := store.LoadJob(e.ctx, e.pool, id, owner); !errors.Is(err, store.ErrJobNotFound) {
				t.Fatalf("job remains %v", err)
			}
		})
	}
}

func TestCleanupHonorsDownloadLeaseThenDeletes(t *testing.T) {
	e := newEnv(t, defaultLimits())
	_, id := newJob(t, e)
	if _, err := e.pool.Exec(e.ctx, `UPDATE jobs SET expires_at=now()-interval '1 second',download_until=now()+interval '1 minute' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	cleaner := jobs.NewCleaner(e.pool, e.st, jobs.CleanupConfig{})
	counts, err := cleaner.Once(e.ctx)
	if err != nil || counts.Jobs != 0 {
		t.Fatalf("cleanup=%+v,%v", counts, err)
	}
	if exists, _ := e.st.Exists(storage.InputKey(id)); !exists {
		t.Fatal("download-protected input gone")
	}
	if _, err := e.pool.Exec(e.ctx, `UPDATE jobs SET download_until=now()-interval '1 second' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	counts, err = cleaner.Once(e.ctx)
	if err != nil || counts.Jobs != 1 {
		t.Fatalf("cleanup=%+v,%v", counts, err)
	}
}

func TestCleanupOrphansAndExpiredUploads(t *testing.T) {
	e := newEnv(t, defaultLimits())
	owner := e.session(t)
	r, err := e.svc.Admit(e.ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	e.spool(t, r, []byte("interrupted"))
	if _, err := e.pool.Exec(e.ctx, `UPDATE upload_reservations SET expires_at=now()-interval '20 seconds'`); err != nil {
		t.Fatal(err)
	}
	orphan := storage.SpoolKey(store.NewID())
	writeResult(t, e, orphan, []byte("orphan"))
	path, _ := e.st.Path(orphan)
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
	orphanID := store.NewID()
	writeResult(t, e, storage.InputKey(orphanID), []byte("orphan job"))
	jobPath, _ := e.st.Path(storage.JobKey(orphanID))
	if err := os.Chtimes(jobPath, old, old); err != nil {
		t.Fatal(err)
	}
	counts, err := jobs.NewCleaner(e.pool, e.st, jobs.CleanupConfig{}).Once(e.ctx)
	if err != nil || counts.Uploads != 1 || counts.Orphans != 2 {
		t.Fatalf("cleanup=%+v,%v", counts, err)
	}
	if _, err := os.Stat(filepath.Join(e.st.Root(), storage.JobKey(orphanID))); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("job orphan remains")
	}
	if budget, reservations := e.reserved(t); budget != 0 || reservations != 0 {
		t.Fatalf("budget=%d,reservations=%d", budget, reservations)
	}
}
