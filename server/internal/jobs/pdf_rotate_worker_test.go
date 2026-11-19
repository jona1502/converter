package jobs_test

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"os"
	"testing"
	"time"

	"miconverter/server/internal/jobs"
	"miconverter/server/internal/store"
)

func newRotateJob(t *testing.T, e env) ([16]byte, [16]byte) {
	t.Helper()
	owner := e.session(t)
	r, err := e.svc.Admit(e.ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	data := []byte("%PDF-1.7\nplaceholder")
	e.spool(t, r, data)
	opts := json.RawMessage(`{"angle":90,"pages":"all","tool":"pdf-rotate"}`)
	a, err := e.svc.Finalize(e.ctx, owner, r, jobs.Upload{Tool: "pdf-rotate", Options: opts, OriginalName: "Bericht.pdf", Size: int64(len(data)), SHA256: sha256.Sum256(data), InputFormat: "pdf", OutputFormat: "pdf"}, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(a.Job.Results) != 1 || a.Job.Results[0].DownloadName != "Bericht-gedreht.pdf" || a.Job.Results[0].MIME != "application/pdf" || a.Job.Results[0].Level != nil {
		t.Fatalf("%+v", a.Job.Results)
	}
	return owner, a.Job.Job.ID
}

func TestPdfRotateWorkerPublishesSinglePDF(t *testing.T) {
	e := newEnv(t, defaultLimits())
	owner, id := newRotateJob(t, e)
	rt := jobs.NewRuntime(e.pool, jobs.RuntimeConfig{})
	task, _, err := rt.ClaimNext(e.ctx)
	if err != nil || task == nil {
		t.Fatal(err)
	}
	if task.Tool != "pdf-rotate" || len(task.Results) != 1 || task.Results[0].Level != "" || task.OutputBudget != jobs.RotateWorkingBytes(int64(len("%PDF-1.7\nplaceholder")), 300_000_000) {
		t.Fatalf("%+v", task)
	}
	processor := processorFunc(func(ctx context.Context, task jobs.Task, emit func(jobs.Event) error) (jobs.Outcome, error) {
		if err := os.WriteFile(task.Results[0].Path, []byte("%PDF-1.7\nrotated"), 0600); err != nil {
			return jobs.Outcome{}, err
		}
		return jobs.Outcome{}, emit(jobs.Event{Kind: jobs.EventResult, ResultID: task.Results[0].ID, Details: json.RawMessage(`{"pageCount":3,"rotatedPages":2}`)})
	})
	jobs.NewWorker(rt, e.st, processor, jobs.WorkerConfig{}).Process(e.ctx, task)
	j, err := store.LoadJob(e.ctx, e.pool, id, owner)
	if err != nil {
		t.Fatal(err)
	}
	if j.Job.State != "succeeded" || j.Job.InputWidth != nil || j.Job.InputHeight != nil || len(j.Results) != 1 {
		t.Fatalf("%+v %+v", j.Job, j.Results)
	}
	if budget, _ := e.reserved(t); budget != j.Job.InputSize+*j.Results[0].Size {
		t.Fatalf("budget %d", budget)
	}
}

func TestPdfRotateWorkerUsesPDFTimeout(t *testing.T) {
	e := newEnv(t, defaultLimits())
	owner, id := newRotateJob(t, e)
	rt := jobs.NewRuntime(e.pool, jobs.RuntimeConfig{ImageTimeout: time.Hour, PDFTimeout: 20 * time.Millisecond})
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
