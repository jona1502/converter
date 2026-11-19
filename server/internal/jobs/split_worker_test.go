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

func newSplitJob(t *testing.T, e env, options, wantName, wantMIME string) ([16]byte, [16]byte) {
	t.Helper()
	owner := e.session(t)
	r, err := e.svc.Admit(e.ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	data := []byte("%PDF-1.7\nsplit")
	e.spool(t, r, data)
	a, err := e.svc.Finalize(e.ctx, owner, r, jobs.Upload{Tool: "pdf-split", Options: json.RawMessage(options), OriginalName: "Bericht.pdf", Size: int64(len(data)), SHA256: sha256.Sum256(data), InputFormat: "pdf", OutputFormat: "pdf"}, "")
	if err != nil {
		t.Fatal(err)
	}
	res := a.Job.Results
	if len(res) != 1 || res[0].DownloadName != wantName || res[0].MIME != wantMIME || res[0].Level != nil {
		t.Fatalf("%+v", res)
	}
	return owner, a.Job.Job.ID
}

func TestSplitFinalizeCreatesSingleResultByOptions(t *testing.T) {
	e := newEnv(t, defaultLimits())
	newSplitJob(t, e, `{"mode":"each","tool":"pdf-split"}`, "Bericht-geteilt.zip", "application/zip")
	newSplitJob(t, e, `{"mode":"ranges","ranges":"2-4","tool":"pdf-split"}`, "Bericht-seiten-2-4.pdf", "application/pdf")
}

func TestSplitWorkerPublishesResultWithinPDFBudget(t *testing.T) {
	e := newEnv(t, defaultLimits())
	owner, id := newSplitJob(t, e, `{"mode":"each","tool":"pdf-split"}`, "Bericht-geteilt.zip", "application/zip")
	rt := jobs.NewRuntime(e.pool, jobs.RuntimeConfig{ImageMaxOutputBytes: 10, PDFMaxResultsTotalBytes: 123456})
	task, _, err := rt.ClaimNext(e.ctx)
	if err != nil || task == nil {
		t.Fatal(err)
	}
	if task.OutputBudget != 123456 || task.Tool != "pdf-split" || len(task.Results) != 1 || task.Results[0].Level != "" {
		t.Fatalf("%+v", task)
	}
	processor := processorFunc(func(ctx context.Context, task jobs.Task, emit func(jobs.Event) error) (jobs.Outcome, error) {
		if err := os.WriteFile(task.Results[0].Path, []byte("PK\x03\x04example"), 0600); err != nil {
			return jobs.Outcome{}, err
		}
		return jobs.Outcome{}, emit(jobs.Event{Kind: jobs.EventResult, ResultID: task.Results[0].ID, Details: json.RawMessage(`{"pageCount":3,"partCount":3}`)})
	})
	jobs.NewWorker(rt, e.st, processor, jobs.WorkerConfig{}).Process(e.ctx, task)
	j, err := store.LoadJob(e.ctx, e.pool, id, owner)
	if err != nil {
		t.Fatal(err)
	}
	if j.Job.State != "succeeded" || j.Job.InputWidth != nil || j.Job.InputHeight != nil || string(j.Results[0].Details) != `{"pageCount": 3, "partCount": 3}` {
		t.Fatalf("%+v %+v", j.Job, j.Results)
	}
}

func TestSplitWorkerUsesPDFTimeout(t *testing.T) {
	e := newEnv(t, defaultLimits())
	owner, id := newSplitJob(t, e, `{"mode":"each","tool":"pdf-split"}`, "Bericht-geteilt.zip", "application/zip")
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
