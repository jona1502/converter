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

func newPdfImageJob(t *testing.T, e env, upload jobs.Upload) ([16]byte, [16]byte, store.LoadedJob) {
	t.Helper()
	owner := e.session(t)
	r, err := e.svc.Admit(e.ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	data := []byte("%PDF-1.7\nexample")
	e.spool(t, r, data)
	upload.Tool, upload.OriginalName, upload.Size = "pdf-to-image", "Mein Bericht.pdf", int64(len(data))
	upload.SHA256, upload.InputFormat = sha256.Sum256(data), "pdf"
	a, err := e.svc.Finalize(e.ctx, owner, r, upload, "")
	if err != nil {
		t.Fatal(err)
	}
	return owner, a.Job.Job.ID, a.Job
}

func TestPdfImageAcceptanceCreatesOneNamedResult(t *testing.T) {
	e := newEnv(t, defaultLimits())
	_, _, archive := newPdfImageJob(t, e, jobs.Upload{Options: json.RawMessage(`{"tool":"pdf-to-image"}`), OutputFormat: "jpeg", PDFArchive: true})
	if len(archive.Results) != 1 || archive.Results[0].DownloadName != "Mein Bericht-bilder.zip" ||
		archive.Results[0].MIME != "application/zip" || archive.Results[0].Level != nil {
		t.Fatalf("Archiv: %+v", archive.Results)
	}
	_, _, single := newPdfImageJob(t, e, jobs.Upload{Options: json.RawMessage(`{"tool":"pdf-to-image","pages":"3"}`), OutputFormat: "jpeg", PDFPage: 3})
	if len(single.Results) != 1 || single.Results[0].DownloadName != "Mein Bericht-seite-3.jpg" || single.Results[0].MIME != "image/jpeg" {
		t.Fatalf("Einzelbild: %+v", single.Results)
	}
	if single.Job.InputName != "Mein Bericht.pdf" {
		t.Fatalf("Anzeigename: %q", single.Job.InputName)
	}
}

func TestPdfImageWorkerPublishesWithinPdfBudget(t *testing.T) {
	e := newEnv(t, defaultLimits())
	owner, id, _ := newPdfImageJob(t, e, jobs.Upload{Options: json.RawMessage(`{"tool":"pdf-to-image"}`), OutputFormat: "png", PDFArchive: true})
	rt := jobs.NewRuntime(e.pool, jobs.RuntimeConfig{ImageMaxOutputBytes: 10, PDFMaxResultsTotalBytes: 7_000_000})
	task, _, err := rt.ClaimNext(e.ctx)
	if err != nil || task == nil {
		t.Fatal(err)
	}
	if task.OutputBudget != 7_000_000 || task.Tool != "pdf-to-image" || len(task.Results) != 1 || task.Results[0].Level != "" {
		t.Fatalf("%+v", task)
	}
	processor := processorFunc(func(ctx context.Context, task jobs.Task, emit func(jobs.Event) error) (jobs.Outcome, error) {
		if err := os.WriteFile(task.Results[0].Path, []byte("PK\x03\x04zip"), 0o600); err != nil {
			return jobs.Outcome{}, err
		}
		return jobs.Outcome{}, emit(jobs.Event{Kind: jobs.EventResult, ResultID: task.Results[0].ID,
			Details: json.RawMessage(`{"pageCount":4,"sourcePageCount":9,"archive":true}`)})
	})
	jobs.NewWorker(rt, e.st, processor, jobs.WorkerConfig{}).Process(e.ctx, task)
	j, err := store.LoadJob(e.ctx, e.pool, id, owner)
	if err != nil {
		t.Fatal(err)
	}
	if j.Job.State != "succeeded" || j.Job.InputWidth != nil || j.Job.InputHeight != nil ||
		string(j.Results[0].Details) != `{"archive": true, "pageCount": 4, "sourcePageCount": 9}` {
		t.Fatalf("%+v %+v details=%s", j.Job, j.Results, j.Results[0].Details)
	}
	if budget, _ := e.reserved(t); budget != j.Job.InputSize+*j.Results[0].Size {
		t.Fatalf("budget %d", budget)
	}
}

func TestPdfImageWorkerUsesPdfTimeout(t *testing.T) {
	e := newEnv(t, defaultLimits())
	owner, id, _ := newPdfImageJob(t, e, jobs.Upload{Options: json.RawMessage(`{"tool":"pdf-to-image"}`), OutputFormat: "png", PDFArchive: true})
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
