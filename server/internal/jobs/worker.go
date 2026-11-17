package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"miconverter/server/internal/storage"
)

// Schnittstelle zur Konvertierung (Adapter auf internal/converter folgt in
// G07) und Worker-Schleife, Portierung von app/worker/runner.py.

// Ereignisarten des Konverters.
const (
	EventProgress = "progress" // Phase (analyze|variant|encode|save) und Progress
	EventAnalysis = "analysis" // Analysis
	EventResult   = "result"   // ResultID fertig geschrieben, Details
	EventError    = "error"    // ResultID fehlgeschlagen mit Code
	EventFatal    = "fatal"    // ganzer Versuch fehlgeschlagen mit Code
)

// Event ist ein bereits validiertes Ereignis des Konverters. Größen meldet
// der Konverter nicht verbindlich: der Worker misst selbst (storage.Size).
type Event struct {
	Kind     string
	Phase    string          // progress
	Progress json.RawMessage // progress, optional
	Analysis json.RawMessage // analysis
	ResultID [16]byte        // result, error
	Details  json.RawMessage // result (JSON-Objekt)
	Code     string          // error, fatal
}

// Outcome ist das Ende eines Process-Aufrufs. ErrorCode "" = regulär
// beendet; sonst z. B. timeout, memory-limit, worker-failed.
type Outcome struct {
	ErrorCode string
}

// Processor führt die Konvertierung eines Tasks aus. Die Ergebnisdateien
// existieren bereits leer (O_EXCL, 0600) unter Task.Results[i].Path; der
// Processor schreibt nur hinein. emit wird synchron aufgerufen; liefert es
// einen Fehler (Lease verloren, Abbruch, fatal), muss Process die Arbeit
// sofort beenden (Kindprozess beenden und warten) und zurückkehren. ctx
// endet bei Lease-Verlust, Abbruch, Zeitlimit oder Herunterfahren.
// Ein zurückgegebener error gilt als worker-failed.
type Processor interface {
	Process(ctx context.Context, task Task, emit func(Event) error) (Outcome, error)
}

// Fehler, die emit an den Processor zurückgibt.
var (
	ErrLeaseLost = errors.New("jobs: Lease verloren oder Abbruch angefordert")
	ErrStop      = errors.New("jobs: Versuch beendet (fatal)")
)

// WorkerConfig steuert die Schleife; Nullwerte → Defaults.
type WorkerConfig struct {
	PollInterval     time.Duration // 1 s bei leerer Queue
	RecoveryInterval time.Duration // 1 s (bisher Dispatcher-Takt)
	// Concurrency: Anzahl gleichzeitig verarbeiteter Aufträge (Slots); Standard 1.
	Concurrency int
	// ShutdownGrace: So lange darf ein laufender Auftrag nach dem
	// Herunterfahrsignal noch fertig werden; danach wird er abgebrochen und
	// seine Lease verfällt (Recovery reiht ihn wieder ein). Standard 20 s.
	ShutdownGrace time.Duration
	Logger        *slog.Logger
}

func (c WorkerConfig) withDefaults() WorkerConfig {
	if c.PollInterval <= 0 {
		c.PollInterval = time.Second
	}
	if c.RecoveryInterval <= 0 {
		c.RecoveryInterval = time.Second
	}
	if c.Concurrency <= 0 {
		c.Concurrency = 1
	}
	if c.ShutdownGrace < 0 {
		c.ShutdownGrace = 0
	} else if c.ShutdownGrace == 0 {
		c.ShutdownGrace = 20 * time.Second
	}
	if c.Logger == nil {
		c.Logger = slog.New(slog.DiscardHandler)
	}
	return c
}

// Worker verarbeitet Aufträge in WorkerConfig.Concurrency parallelen Slots.
type Worker struct {
	rt        *Runtime
	storage   *storage.Local
	processor Processor
	cfg       WorkerConfig
	// Background läuft für die Dauer von Run in eigener Goroutine (z. B. die
	// Capabilities-Probe ab G07); optional.
	Background func(ctx context.Context)
}

// NewWorker erzeugt einen Worker.
func NewWorker(rt *Runtime, st *storage.Local, p Processor, cfg WorkerConfig) *Worker {
	return &Worker{rt: rt, storage: st, processor: p, cfg: cfg.withDefaults()}
}

// Run pollt die Queue, bis ctx endet. Recovery (und Background) laufen in
// eigenen Goroutinen unabhängig vom Verarbeitungsslot. Beim Herunterfahren
// wird kein neuer Auftrag beansprucht; ein laufender erhält ShutdownGrace,
// danach wird er abgebrochen, ohne Finish: seine Lease verfällt und die
// Recovery reiht ihn wieder ein (kostet einen Versuch). Run kehrt erst
// zurück, wenn alle Goroutinen beendet sind.
func (w *Worker) Run(ctx context.Context) error {
	var wg sync.WaitGroup
	wg.Go(func() { w.recoveryLoop(ctx) })
	if w.Background != nil {
		wg.Go(func() { w.Background(ctx) })
	}
	defer wg.Wait()

	for range w.cfg.Concurrency {
		wg.Go(func() { w.slotLoop(ctx) })
	}
	return nil
}

// slotLoop beansprucht und verarbeitet Aufträge nacheinander. Mehrere Slots
// teilen sich die Queue; FOR UPDATE SKIP LOCKED verteilt die Einträge.
func (w *Worker) slotLoop(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}
		task, consumed, err := w.rt.ClaimNext(ctx)
		switch {
		case err != nil:
			if ctx.Err() != nil {
				return
			}
			w.cfg.Logger.Warn("Claim fehlgeschlagen", "errorType", fmt.Sprintf("%T", err))
		case task != nil:
			w.Process(ctx, task)
			continue
		case consumed:
			continue
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(w.cfg.PollInterval):
		}
	}
}

func (w *Worker) recoveryLoop(ctx context.Context) {
	ticker := time.NewTicker(w.cfg.RecoveryInterval)
	defer ticker.Stop()
	for {
		if n, err := w.rt.Recover(ctx); err != nil && ctx.Err() == nil {
			w.cfg.Logger.Warn("Recovery fehlgeschlagen", "errorType", fmt.Sprintf("%T", err))
		} else if n > 0 {
			w.cfg.Logger.Info("Aufträge zurückgeholt", "count", n)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// stopCause unterscheidet, warum die Verarbeitung endete.
var (
	errShutdown = errors.New("jobs: Herunterfahren")
	errTimeout  = errors.New("jobs: Zeitlimit")
)

// Process verarbeitet einen beanspruchten Task vollständig (runner.run_job).
// runCtx ist der Context der Worker-Schleife; sein Ende bedeutet
// Herunterfahren mit ShutdownGrace.
func (w *Worker) Process(runCtx context.Context, task *Task) {
	log := w.cfg.Logger.With("job", storage.FormatUUID(task.JobID))
	jobCtx, cancel := context.WithCancelCause(context.WithoutCancel(runCtx))
	defer cancel(nil)

	timeout := w.rt.cfg.ImageTimeout
	switch task.Tool {
	case "markdown-pdf":
		timeout = w.rt.cfg.MarkdownTimeout
	case "pdf-compress":
		timeout = w.rt.cfg.PDFTimeout
	case "audio-convert":
		timeout = w.rt.cfg.AudioTimeout
	}
	timer := time.AfterFunc(timeout, func() { cancel(errTimeout) })
	defer timer.Stop()

	// Herunterfahren: nach ShutdownGrace abbrechen.
	stopShutdownWatch := context.AfterFunc(runCtx, func() {
		t := time.AfterFunc(w.cfg.ShutdownGrace, func() { cancel(errShutdown) })
		context.AfterFunc(jobCtx, func() { t.Stop() })
	})
	defer stopShutdownWatch()

	published := map[[16]byte]bool{}
	uncertain := map[[16]byte]bool{}
	created := make([]TaskResult, 0, len(task.Results))
	errorCode := ""

	defer func() {
		// Nur eigene, nicht veröffentlichte Dateien entfernen.
		retainWorking := len(uncertain) > 0
		for _, r := range created {
			if !published[r.ID] && !uncertain[r.ID] {
				if err := w.storage.Delete(r.Key); err != nil {
					retainWorking = true
					log.Warn("Ergebnisdatei nicht entfernt", "errorType", fmt.Sprintf("%T", err))
				}
			}
		}
		if retainWorking {
			// Keep the reservation until Recovery transfers it to stale_attempts
			// and Cleanup can prove all unreferenced files physically gone.
			return
		}
		if errors.Is(context.Cause(jobCtx), errShutdown) {
			// Lease verfallen lassen; Recovery übernimmt.
			return
		}
		finishCtx, done := context.WithTimeout(context.WithoutCancel(runCtx), 10*time.Second)
		defer done()
		if err := w.rt.Finish(finishCtx, task, errorCode); err != nil {
			log.Warn("Abschluss fehlgeschlagen; Lease verfällt", "errorType", fmt.Sprintf("%T", err))
		}
	}()

	// Leere Ergebnisdateien je Lease anlegen; der Parser schreibt nur hinein.
	for i := range task.Results {
		r := &task.Results[i]
		wr, err := w.storage.Create(r.Key)
		if err == nil {
			err = wr.Close()
		}
		if err != nil {
			log.Warn("Ergebnisdatei nicht anlegbar", "errorType", fmt.Sprintf("%T", err))
			errorCode = "worker-failed"
			return
		}
		created = append(created, *r)
		r.Path = wr.Path()
	}
	inputPath, err := w.storage.Path(task.InputKey)
	if err != nil {
		errorCode = "worker-failed"
		return
	}
	task.InputPath = inputPath

	// Heartbeat in eigener Goroutine; Lease-Verlust/Abbruch beendet jobCtx.
	var hb sync.WaitGroup
	hbCtx, stopHB := context.WithCancel(jobCtx)
	hb.Go(func() {
		ticker := time.NewTicker(w.rt.cfg.HeartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-hbCtx.Done():
				return
			case <-ticker.C:
			}
			ok, err := w.rt.Heartbeat(hbCtx, task)
			if err != nil {
				// Vorübergehender DB-Fehler: weiter versuchen; ist die Lease
				// inzwischen abgelaufen, liefert der nächste Heartbeat false.
				if hbCtx.Err() == nil {
					log.Warn("Heartbeat fehlgeschlagen", "errorType", fmt.Sprintf("%T", err))
				}
				continue
			}
			if !ok {
				cancel(ErrLeaseLost)
				return
			}
		}
	})
	defer func() { stopHB(); hb.Wait() }()

	results := make(map[[16]byte]TaskResult, len(task.Results))
	for _, r := range task.Results {
		results[r.ID] = r
	}
	fatal := ""
	emit := func(ev Event) error {
		if cause := context.Cause(jobCtx); cause != nil {
			return ErrLeaseLost
		}
		switch ev.Kind {
		case EventProgress:
			switch ev.Phase {
			case "", "analyze", "variant", "encode", "save":
			default:
				return fmt.Errorf("jobs: unbekannte Phase %q", ev.Phase)
			}
			return w.lost(w.rt.Progress(jobCtx, task, ev.Phase, ev.Progress))
		case EventAnalysis:
			return w.lost(w.rt.Analysis(jobCtx, task, ev.Analysis))
		case EventError:
			if _, ok := results[ev.ResultID]; !ok || ev.Code == "" {
				return errors.New("jobs: Fehlerereignis für unbekanntes Ergebnis")
			}
			return w.lost(w.rt.FailResult(jobCtx, task, ev.ResultID, ev.Code))
		case EventFatal:
			fatal = ev.Code
			if fatal == "" {
				fatal = "worker-failed"
			}
			return ErrStop
		case EventResult:
			r, ok := results[ev.ResultID]
			if !ok || published[r.ID] {
				return errors.New("jobs: Ergebnisereignis für unbekanntes Ergebnis")
			}
			// Vertrauensgrenze: Größe aus dem Dateisystem, nicht vom Parser.
			size, err := w.storage.Size(r.Key)
			if err == nil {
				err = w.storage.Sync(r.Key)
			}
			if err != nil {
				return err
			}
			ok, err = w.rt.PublishResult(jobCtx, task, r.ID, size, ev.Details)
			if err != nil {
				// Commit unklar: nachsehen, bevor die Datei gelöscht wird.
				checkCtx, done := context.WithTimeout(context.WithoutCancel(jobCtx), 5*time.Second)
				defer done()
				if pub, checkErr := w.rt.IsPublished(checkCtx, task, r.ID); checkErr == nil {
					published[r.ID] = pub
				} else {
					uncertain[r.ID] = true // Cleanup entfernt sie mit dem Auftrag
				}
				return err
			}
			if ok {
				published[r.ID] = true
			} else if err := w.storage.Delete(r.Key); err != nil {
				log.Warn("abgelehnte Ergebnisdatei nicht entfernt", "errorType", fmt.Sprintf("%T", err))
			}
			return nil
		}
		return fmt.Errorf("jobs: unbekannte Ereignisart %q", ev.Kind)
	}

	outcome, procErr := w.processor.Process(jobCtx, *task, emit)
	cause := context.Cause(jobCtx)
	switch {
	case fatal != "":
		errorCode = fatal
	case errors.Is(cause, errTimeout):
		errorCode = "timeout"
	case errors.Is(cause, ErrLeaseLost), errors.Is(cause, errShutdown):
		// Lease verloren/Abbruch: Finish entscheidet anhand der DB (cancelled
		// oder nichts); beim Herunterfahren entfällt Finish.
	case procErr != nil:
		errorCode = "worker-failed"
		log.Warn("Verarbeitung fehlgeschlagen", "errorType", fmt.Sprintf("%T", procErr))
	default:
		errorCode = outcome.ErrorCode
	}
}

// lost übersetzt das Ergebnis einer owned()-Operation für emit.
func (w *Worker) lost(ok bool, err error) error {
	if err != nil {
		return err
	}
	if !ok {
		return ErrLeaseLost
	}
	return nil
}
