package jobs_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"miconverter/server/internal/jobs"
	"miconverter/server/internal/store"
)

func TestQueuedJobsReportPositionInProgress(t *testing.T) {
	e := newEnv(t, defaultLimits())
	ownerA, first := newJob(t, e)
	ownerB, second := newJob(t, e)
	position := func(owner, id [16]byte) string {
		loaded, err := store.LoadJob(e.ctx, e.pool, id, owner)
		if err != nil {
			t.Fatal(err)
		}
		return string(loaded.View(time.Now()).Progress)
	}
	if got := position(ownerA, first); got != `{"step":"queue","position":1}` {
		t.Fatalf("first=%s", got)
	}
	if got := position(ownerB, second); got != `{"step":"queue","position":2}` {
		t.Fatalf("second=%s", got)
	}
	rt := jobs.NewRuntime(e.pool, jobs.RuntimeConfig{})
	if task, _, err := rt.ClaimNext(e.ctx); err != nil || task == nil {
		t.Fatal(err)
	}
	if got := position(ownerB, second); got != `{"step":"queue","position":1}` {
		t.Fatalf("second after claim=%s", got)
	}
	if got := position(ownerA, first); got != "" {
		t.Fatalf("running job must not report a queue position: %s", got)
	}
}

func TestWorkerRunsConfiguredNumberOfJobsConcurrently(t *testing.T) {
	e := newEnv(t, defaultLimits())
	newJob(t, e)
	newJob(t, e)
	rt := jobs.NewRuntime(e.pool, jobs.RuntimeConfig{})
	started := make(chan struct{}, 2)
	release := make(chan struct{})
	processor := processorFunc(func(ctx context.Context, task jobs.Task, emit func(jobs.Event) error) (jobs.Outcome, error) {
		if err := emit(jobs.Event{Kind: jobs.EventProgress, Phase: "encode", Progress: json.RawMessage(`{"step":"encode","current":1,"total":2}`)}); err != nil {
			return jobs.Outcome{}, err
		}
		started <- struct{}{}
		select {
		case <-release:
		case <-ctx.Done():
		}
		return jobs.Outcome{ErrorCode: "worker-failed"}, nil
	})
	ctx, stop := context.WithCancel(e.ctx)
	done := make(chan error, 1)
	worker := jobs.NewWorker(rt, e.st, processor, jobs.WorkerConfig{Concurrency: 2, PollInterval: 10 * time.Millisecond})
	go func() { done <- worker.Run(ctx) }()
	for range 2 {
		select {
		case <-started:
		case <-time.After(10 * time.Second):
			t.Fatal("two jobs did not run in parallel")
		}
	}
	close(release)
	stop()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
