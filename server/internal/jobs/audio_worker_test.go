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

func newAudioJob(t *testing.T, e env) ([16]byte, [16]byte) {
	t.Helper()
	owner := e.session(t)
	r, err := e.svc.Admit(e.ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	data := []byte("RIFF\x24\x00\x00\x00WAVE")
	e.spool(t, r, data)
	acc, err := e.svc.Finalize(e.ctx, owner, r, audioUpload(data, "wav", "flac"), "")
	if err != nil {
		t.Fatal(err)
	}
	return owner, acc.Job.Job.ID
}

func TestRuntimeDefaultsForAudio(t *testing.T) {
	d := jobs.DefaultRuntimeConfig()
	if d.AudioMaxOutputBytes != 419_430_400 || d.AudioTimeout != 300*time.Second {
		t.Fatalf("Standard = %+v", d)
	}
}

func TestWorkerAudioReservesAudioOutputBudget(t *testing.T) {
	e := newEnv(t, defaultLimits())
	owner, id := newAudioJob(t, e)
	rt := jobs.NewRuntime(e.pool, jobs.RuntimeConfig{ImageMaxOutputBytes: 100, AudioMaxOutputBytes: 5000})
	task, _, err := rt.ClaimNext(e.ctx)
	if err != nil || task == nil || task.Tool != "audio-convert" || task.OutputBudget != 5000 {
		t.Fatalf("Claim = %+v, %v", task, err)
	}
	output := make([]byte, 2000) // größer als die Bild-, kleiner als die Audioreserve
	processor := processorFunc(func(ctx context.Context, task jobs.Task, emit func(jobs.Event) error) (jobs.Outcome, error) {
		if err := os.WriteFile(task.Results[0].Path, output, 0600); err != nil {
			return jobs.Outcome{}, err
		}
		details := json.RawMessage(`{"format":"flac","durationSeconds":0.5,"sampleRate":44100,"channels":2,"qualityApplied":false}`)
		return jobs.Outcome{}, emit(jobs.Event{Kind: jobs.EventResult, ResultID: task.Results[0].ID, Details: details})
	})
	jobs.NewWorker(rt, e.st, processor, jobs.WorkerConfig{}).Process(e.ctx, task)
	loaded, err := store.LoadJob(e.ctx, e.pool, id, owner)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Job.State != "succeeded" || *loaded.Results[0].Size != int64(len(output)) ||
		loaded.Job.InputWidth != nil || loaded.Job.InputHeight != nil {
		t.Fatalf("job=%+v results=%+v", loaded.Job, loaded.Results)
	}
	if budget, _ := e.reserved(t); budget != loaded.Job.InputSize+int64(len(output)) {
		t.Fatalf("budget=%d", budget)
	}
}

func TestWorkerAudioUsesAudioTimeout(t *testing.T) {
	e := newEnv(t, defaultLimits())
	owner, id := newAudioJob(t, e)
	rt := jobs.NewRuntime(e.pool, jobs.RuntimeConfig{ImageTimeout: time.Hour, AudioTimeout: 20 * time.Millisecond})
	task, _, err := rt.ClaimNext(e.ctx)
	if err != nil || task == nil {
		t.Fatal(err)
	}
	processor := processorFunc(func(ctx context.Context, task jobs.Task, emit func(jobs.Event) error) (jobs.Outcome, error) {
		<-ctx.Done()
		return jobs.Outcome{}, ctx.Err()
	})
	jobs.NewWorker(rt, e.st, processor, jobs.WorkerConfig{}).Process(e.ctx, task)
	loaded, err := store.LoadJob(e.ctx, e.pool, id, owner)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Job.State != "failed" || loaded.Job.ErrorCode == nil || *loaded.Job.ErrorCode != "timeout" {
		t.Fatalf("job=%+v", loaded.Job)
	}
}
