package converter

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"miconverter/server/internal/config"
	"miconverter/server/internal/jobs"
	"miconverter/server/internal/storage"
)

// Processor verbindet die Auftragssteuerung mit dem privaten Prozessprotokoll.
// Keine Dateipfade oder IDs aus dem Kindprozess werden als Autorität übernommen.
type Processor struct {
	runner *Runner
	cfg    *config.Config
}

func NewProcessor(runner *Runner, cfg *config.Config) *Processor {
	if runner == nil {
		runner = NewRunner()
	}
	return &Processor{runner: runner, cfg: cfg}
}

func (p *Processor) request(task jobs.Task) (Request, error) {
	c := p.cfg
	limits := Limits{
		ImageMaxInputBytes: c.ImageMaxInputBytes, ImageMaxPixels: c.ImageMaxPixels,
		ImageMaxEdge: int64(c.ImageMaxEdge), ImageMaxOutputBytes: c.ImageMaxOutputBytes,
		PdfMaxInputBytes: c.PdfMaxInputBytes, PdfMaxResultsTotalBytes: c.PdfMaxResultsTotalBytes,
		PdfImageMaxPixels:  c.PdfImageMaxPixels,
		AudioMaxInputBytes: c.AudioMaxInputBytes, AudioMaxDurationSeconds: c.AudioMaxDurationSeconds,
		AudioMaxChannels: c.AudioMaxChannels, AudioMaxSampleRate: c.AudioMaxSampleRate,
		AudioMaxOutputBytes: c.AudioMaxOutputBytes,
	}
	req := Request{Source: task.InputPath, Options: task.Options, Limits: limits,
		MemoryBytes: 1 << 30, Timeout: c.ImageTimeout, OutputLimit: c.ImageMaxOutputBytes}
	for _, target := range task.Results {
		req.Results = append(req.Results, ResultTarget{ID: storage.FormatUUID(target.ID), Level: target.Level, Path: target.Path})
	}
	if task.Tool == "pdf-compress" {
		if task.OutputBudget <= 0 {
			return Request{}, invalid("PDF-Arbeitsbudget fehlt")
		}
		req.Limits.PdfMaxResultsTotalBytes = min(c.PdfMaxResultsTotalBytes, task.OutputBudget)
		req.Timeout = c.PdfTimeout
		// Recoveries retain already published variants; the isolated process only
		// receives the still-pending levels, in their original order.
		var options map[string]json.RawMessage
		if err := json.Unmarshal(task.Options, &options); err != nil {
			return Request{}, fmt.Errorf("converter: task options: %w", err)
		}
		levels := make([]string, 0, len(task.Results))
		for _, result := range task.Results {
			levels = append(levels, result.Level)
		}
		encoded, err := json.Marshal(levels)
		if err != nil {
			return Request{}, err
		}
		options["levels"] = encoded
		req.Options, err = json.Marshal(options)
		if err != nil {
			return Request{}, err
		}
		req.OutputLimit = req.Limits.PdfMaxResultsTotalBytes
	}
	return req, nil
}

func (p *Processor) Process(ctx context.Context, task jobs.Task, emit func(jobs.Event) error) (jobs.Outcome, error) {
	req, err := p.request(task)
	if err != nil {
		return jobs.Outcome{}, err
	}
	ids := map[string][16]byte{}
	for _, target := range task.Results {
		ids[storage.FormatUUID(target.ID)] = target.ID
	}
	out, err := p.runner.Run(ctx, req, func(event Event) error {
		next := jobs.Event{Kind: string(event.Kind), Phase: event.Phase, Analysis: event.Analysis, Details: event.Details, Code: event.Code}
		if event.ResultID != "" {
			next.ResultID = ids[event.ResultID]
		}
		if event.Progress != nil {
			var marshalErr error
			next.Progress, marshalErr = json.Marshal(event.Progress)
			if marshalErr != nil {
				return marshalErr
			}
		}
		return emit(next)
	})
	return jobs.Outcome{ErrorCode: out.ErrorCode}, err
}

// PublishLoop refreshes capabilities independently of conversion slots. The
// first successful probe enables API readiness; failure never fabricates formats.
func PublishLoop(ctx context.Context, runner *Runner, path string, logger *slog.Logger) {
	if runner == nil {
		runner = NewRunner()
	}
	if logger == nil {
		logger = slog.Default()
	}
	for {
		report, err := runner.Probe(ctx)
		if err == nil {
			err = WriteReport(path, report)
		}
		if err != nil && ctx.Err() == nil {
			logger.Error("converter capabilities unavailable", "errorType", fmt.Sprintf("%T", err))
		}
		wait := 5 * time.Minute
		if err != nil {
			wait = 5 * time.Second
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}
