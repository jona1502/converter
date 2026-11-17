package jobs_test

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"miconverter/server/internal/jobs"
	"miconverter/server/internal/store"
	"os"
	"testing"
	"time"
)

func newMarkdownJob(t *testing.T, e env) ([16]byte, [16]byte) {
	t.Helper()
	owner := e.session(t)
	r, err := e.svc.Admit(e.ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	data := []byte("# Grüße")
	e.spool(t, r, data)
	a, err := e.svc.Finalize(e.ctx, owner, r, jobs.Upload{Tool: "markdown-pdf", Options: json.RawMessage(`{"tool":"markdown-pdf"}`), OriginalName: "con.md", Size: int64(len(data)), SHA256: sha256.Sum256(data), InputFormat: "markdown", OutputFormat: "pdf"}, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(a.Job.Results) != 1 || a.Job.Results[0].DownloadName != "_con.pdf" || a.Job.Results[0].MIME != "application/pdf" || a.Job.Results[0].Level != nil {
		t.Fatalf("%+v", a.Job.Results)
	}
	return owner, a.Job.Job.ID
}
func TestMarkdownWorkerPublishesSinglePDFWithinReservation(t *testing.T) {
	e := newEnv(t, defaultLimits())
	owner, id := newMarkdownJob(t, e)
	rt := jobs.NewRuntime(e.pool, jobs.RuntimeConfig{ImageMaxOutputBytes: 10})
	task, _, err := rt.ClaimNext(e.ctx)
	if err != nil || task == nil {
		t.Fatal(err)
	}
	if task.OutputBudget != 20971520 || task.Tool != "markdown-pdf" || len(task.Results) != 1 || task.Results[0].Level != "" {
		t.Fatalf("%+v", task)
	}
	processor := processorFunc(func(ctx context.Context, task jobs.Task, emit func(jobs.Event) error) (jobs.Outcome, error) {
		if err := os.WriteFile(task.Results[0].Path, []byte("%PDF-1.7\nexample"), 0600); err != nil {
			return jobs.Outcome{}, err
		}
		return jobs.Outcome{}, emit(jobs.Event{Kind: jobs.EventResult, ResultID: task.Results[0].ID, Details: json.RawMessage(`{"pageCount":2}`)})
	})
	jobs.NewWorker(rt, e.st, processor, jobs.WorkerConfig{}).Process(e.ctx, task)
	j, err := store.LoadJob(e.ctx, e.pool, id, owner)
	if err != nil {
		t.Fatal(err)
	}
	if j.Job.State != "succeeded" || j.Job.InputWidth != nil || j.Job.InputHeight != nil || string(j.Results[0].Details) != `{"pageCount": 2}` {
		t.Fatalf("%+v %+v", j.Job, j.Results)
	}
	if budget, _ := e.reserved(t); budget != j.Job.InputSize+*j.Results[0].Size {
		t.Fatalf("budget %d", budget)
	}
}
func TestMarkdownWorkerUsesOwnTimeout(t *testing.T) {
	e := newEnv(t, defaultLimits())
	owner, id := newMarkdownJob(t, e)
	rt := jobs.NewRuntime(e.pool, jobs.RuntimeConfig{ImageTimeout: time.Hour, MarkdownTimeout: 20 * time.Millisecond})
	task, _, err := rt.ClaimNext(e.ctx)
	if err != nil || task == nil {
		t.Fatal(err)
	}
	processor := processorFunc(func(ctx context.Context, task jobs.Task, emit func(jobs.Event) error) (jobs.Outcome, error) {
		<-ctx.Done()
		return jobs.Outcome{}, ctx.Err()
	})
	jobs.NewWorker(rt, e.st, processor, jobs.WorkerConfig{}).Process(e.ctx, task)
	j, err := store.LoadJob(e.ctx, e.pool, id, owner)
	if err != nil {
		t.Fatal(err)
	}
	if j.Job.State != "failed" || j.Job.ErrorCode == nil || *j.Job.ErrorCode != "timeout" {
		t.Fatalf("%+v", j.Job)
	}
}
