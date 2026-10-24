package jobs_test

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"miconverter/server/internal/jobs"
	"miconverter/server/internal/store"
)

type processorFunc func(context.Context, jobs.Task, func(jobs.Event) error) (jobs.Outcome, error)

func (f processorFunc) Process(ctx context.Context, task jobs.Task, emit func(jobs.Event) error) (jobs.Outcome, error) {
	return f(ctx, task, emit)
}

func TestWorkerPublishesMeasuredBytesAndFinishes(t *testing.T) {
	e := newEnv(t, defaultLimits())
	owner, id := newJob(t, e)
	rt := jobs.NewRuntime(e.pool, jobs.RuntimeConfig{})
	task, _, err := rt.ClaimNext(e.ctx)
	if err != nil || task == nil {
		t.Fatal(err)
	}
	processor := processorFunc(func(ctx context.Context, task jobs.Task, emit func(jobs.Event) error) (jobs.Outcome, error) {
		if err := os.WriteFile(task.Results[0].Path, []byte("real output bytes"), 0600); err != nil {
			return jobs.Outcome{}, err
		}
		err := emit(jobs.Event{Kind: jobs.EventResult, ResultID: task.Results[0].ID, Details: json.RawMessage(`{"sourceWidth":160,"sourceHeight":96}`)})
		return jobs.Outcome{}, err
	})
	worker := jobs.NewWorker(rt, e.st, processor, jobs.WorkerConfig{})
	worker.Process(e.ctx, task)
	loaded, err := store.LoadJob(e.ctx, e.pool, id, owner)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Job.State != "succeeded" || len(loaded.Results) != 1 || loaded.Results[0].Size == nil || *loaded.Results[0].Size != int64(len("real output bytes")) {
		t.Fatalf("job=%+v results=%+v", loaded.Job, loaded.Results)
	}
	if budget, _ := e.reserved(t); budget != loaded.Job.InputSize+int64(len("real output bytes")) {
		t.Fatalf("budget=%d", budget)
	}
}

func TestWorkerTimeoutCancelsProcessorAndReleasesWorkingBytes(t *testing.T) {
	e := newEnv(t, defaultLimits())
	owner, id := newJob(t, e)
	rt := jobs.NewRuntime(e.pool, jobs.RuntimeConfig{ImageTimeout: 20 * time.Millisecond})
	task, _, err := rt.ClaimNext(e.ctx)
	if err != nil || task == nil {
		t.Fatal(err)
	}
	stopped := false
	processor := processorFunc(func(ctx context.Context, task jobs.Task, emit func(jobs.Event) error) (jobs.Outcome, error) {
		<-ctx.Done()
		stopped = true
		return jobs.Outcome{}, ctx.Err()
	})
	jobs.NewWorker(rt, e.st, processor, jobs.WorkerConfig{}).Process(e.ctx, task)
	loaded, err := store.LoadJob(e.ctx, e.pool, id, owner)
	if err != nil {
		t.Fatal(err)
	}
	if !stopped || loaded.Job.State != "failed" || loaded.Job.ErrorCode == nil || *loaded.Job.ErrorCode != "timeout" {
		t.Fatalf("job=%+v", loaded.Job)
	}
	if exists, _ := e.st.Exists(task.Results[0].Key); exists {
		t.Fatal("partial file remains")
	}
	if budget, _ := e.reserved(t); budget != loaded.Job.InputSize {
		t.Fatalf("budget=%d", budget)
	}
}

func TestWorkerCancellationWinsBeforePublication(t *testing.T) {
	e := newEnv(t, defaultLimits())
	owner, id := newJob(t, e)
	rt := jobs.NewRuntime(e.pool, jobs.RuntimeConfig{HeartbeatInterval: 10 * time.Millisecond})
	task, _, err := rt.ClaimNext(e.ctx)
	if err != nil || task == nil {
		t.Fatal(err)
	}
	processor := processorFunc(func(ctx context.Context, task jobs.Task, emit func(jobs.Event) error) (jobs.Outcome, error) {
		_, _, err := store.Cancel(ctx, e.pool, owner, id)
		if err != nil {
			return jobs.Outcome{}, err
		}
		<-ctx.Done()
		return jobs.Outcome{}, ctx.Err()
	})
	jobs.NewWorker(rt, e.st, processor, jobs.WorkerConfig{}).Process(e.ctx, task)
	loaded, err := store.LoadJob(e.ctx, e.pool, id, owner)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Job.State != "cancelled" || loaded.Results[0].State != "cancelled" {
		t.Fatalf("job=%+v result=%+v", loaded.Job, loaded.Results[0])
	}
}

func TestQueuedExhaustedOrStorageFullClaimsEndResultRows(t *testing.T) {
	for _, mode := range []string{"attempts", "storage"} {
		t.Run(mode, func(t *testing.T) {
			e := newEnv(t, defaultLimits())
			owner, id := newJob(t, e)
			cfg := jobs.RuntimeConfig{}
			if mode == "attempts" {
				if _, err := e.pool.Exec(e.ctx, `UPDATE jobs SET attempts=max_attempts WHERE id=$1`, id); err != nil {
					t.Fatal(err)
				}
			} else {
				cfg.StorageBudgetBytes = 1
			}
			rt := jobs.NewRuntime(e.pool, cfg)
			task, consumed, err := rt.ClaimNext(e.ctx)
			if err != nil || task != nil || !consumed {
				t.Fatalf("claim=%+v,%v,%v", task, consumed, err)
			}
			loaded, err := store.LoadJob(e.ctx, e.pool, id, owner)
			if err != nil {
				t.Fatal(err)
			}
			if loaded.Job.State != "failed" || loaded.Results[0].State != "failed" {
				t.Fatalf("nonterminal failed claim %+v %+v", loaded.Job, loaded.Results[0])
			}
		})
	}
}
