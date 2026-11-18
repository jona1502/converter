package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"miconverter/server/internal/storage"
	"miconverter/server/internal/store"
)

// Dauerhafte Queue und atomare Worker-Übergänge, Portierung von
// app/jobs/runtime.py und dem Claim aus docs/go-backend/architecture.md §4.
// PostgreSQL entscheidet; jeder Schreibzugriff des Workers ist an die volle
// owned()-Bedingung gebunden.

// RuntimeConfig enthält die Grenzen und Zeiten der Verarbeitung. Nullwerte
// werden durch DefaultRuntimeConfig ersetzt.
type RuntimeConfig struct {
	MarkdownMaxOutputBytes  int64
	MarkdownTimeout         time.Duration
	ImageMaxOutputBytes     int64         // 104_857_600, Arbeitsreserve je Bildauftrag
	PDFMaxResultsTotalBytes int64         // 300_000_000, Gesamtbudget je PDF-Auftrag
	AudioMaxOutputBytes     int64         // 419_430_400, Arbeitsreserve je Audioauftrag
	StorageBudgetBytes      int64         // 5_000_000_000
	Lease                   time.Duration // 30 s (LEASE_SECONDS)
	HeartbeatInterval       time.Duration // 2 s (runner.py)
	ImageTimeout            time.Duration // 120 s
	PDFTimeout              time.Duration // 300 s
	AudioTimeout            time.Duration // 300 s
}

// DefaultRuntimeConfig entspricht den Python-Defaults.
func DefaultRuntimeConfig() RuntimeConfig {
	return RuntimeConfig{
		MarkdownMaxOutputBytes: 20_971_520, MarkdownTimeout: 120 * time.Second,
		ImageMaxOutputBytes:     104_857_600,
		PDFMaxResultsTotalBytes: 300_000_000,
		AudioMaxOutputBytes:     419_430_400,
		StorageBudgetBytes:      5_000_000_000,
		Lease:                   30 * time.Second,
		HeartbeatInterval:       2 * time.Second,
		ImageTimeout:            120 * time.Second,
		PDFTimeout:              300 * time.Second,
		AudioTimeout:            300 * time.Second,
	}
}

func (c RuntimeConfig) withDefaults() RuntimeConfig {
	d := DefaultRuntimeConfig()
	if c.MarkdownMaxOutputBytes <= 0 {
		c.MarkdownMaxOutputBytes = d.MarkdownMaxOutputBytes
	}
	if c.MarkdownTimeout <= 0 {
		c.MarkdownTimeout = d.MarkdownTimeout
	}
	if c.ImageMaxOutputBytes <= 0 {
		c.ImageMaxOutputBytes = d.ImageMaxOutputBytes
	}
	if c.PDFMaxResultsTotalBytes <= 0 {
		c.PDFMaxResultsTotalBytes = d.PDFMaxResultsTotalBytes
	}
	if c.AudioMaxOutputBytes <= 0 {
		c.AudioMaxOutputBytes = d.AudioMaxOutputBytes
	}
	if c.AudioTimeout <= 0 {
		c.AudioTimeout = d.AudioTimeout
	}
	if c.StorageBudgetBytes <= 0 {
		c.StorageBudgetBytes = d.StorageBudgetBytes
	}
	if c.Lease <= 0 {
		c.Lease = d.Lease
	}
	if c.HeartbeatInterval <= 0 {
		c.HeartbeatInterval = d.HeartbeatInterval
	}
	if c.ImageTimeout <= 0 {
		c.ImageTimeout = d.ImageTimeout
	}
	if c.PDFTimeout <= 0 {
		c.PDFTimeout = d.PDFTimeout
	}
	return c
}

// staleGrace: stale_attempts.reap_after = now + max(Timeouts) + 10 s
// (runtime.retire_attempt), damit ein verwaister Kindprozess sicher beendet ist.
func (c RuntimeConfig) staleGrace() time.Duration {
	return max(c.ImageTimeout, c.PDFTimeout, c.AudioTimeout, c.MarkdownTimeout) + 10*time.Second
}

// Runtime führt die Datenbankübergänge eines Workers aus.
type Runtime struct {
	pool *pgxpool.Pool
	cfg  RuntimeConfig
}

// NewRuntime erzeugt die Laufzeit; cfg-Nullwerte → Defaults.
func NewRuntime(pool *pgxpool.Pool, cfg RuntimeConfig) *Runtime {
	return &Runtime{pool: pool, cfg: cfg.withDefaults()}
}

// Config liefert die wirksame Konfiguration.
func (rt *Runtime) Config() RuntimeConfig { return rt.cfg }

// TaskResult ist eine zu erzeugende Ergebnisdatei dieses Versuchs.
type TaskResult struct {
	ID    [16]byte
	Level string // "" bei Bildern, sonst high|balanced|small
	Key   string // jobs/<job>/results/<result>/<lease>
	Path  string // absoluter Pfad, gesetzt vom Worker nach dem Anlegen
}

// Task ist ein beanspruchter Auftrag (runtime.Claim).
type Task struct {
	JobID        [16]byte
	Lease        [16]byte
	Tool         string
	Options      json.RawMessage
	InputKey     string
	InputPath    string // gesetzt vom Worker
	OutputBudget int64  // remaining reserved output bytes for this attempt
	// Results: nur noch nicht veröffentlichte Ergebnisse, nach ordinal.
	Results []TaskResult
}

// ownedSQL ist runtime.owned(): $1 = Auftrag, $2 = Lease.
const ownedSQL = `id = $1 AND state = 'running' AND lease_token = $2
  AND lease_expires_at > now() AND deleted_at IS NULL AND expires_at > now()`

// ClaimNext beansprucht den ältesten fälligen Dispatch-Eintrag
// (architecture.md §4, Schritte 1–5) in einer kurzen Transaktion:
//
//   - task != nil: Auftrag läuft unter neuer Lease.
//   - task == nil, consumed: Eintrag verbraucht, Auftrag nicht beanspruchbar
//     (Duplikat, abgebrochen, gelöscht, abgelaufen, Versuche erschöpft,
//     storage-full). Sofort weiter pollen.
//   - task == nil, !consumed: Queue leer.
//
// Scheitert die Transaktion technisch, erhält der Eintrag in einer eigenen
// Transaktion attempts+1, last_error (nur Fehlerklasse) und Backoff
// min(60, 2^attempts) s, wie der bisherige Dispatcher.
func (rt *Runtime) ClaimNext(ctx context.Context) (task *Task, consumed bool, err error) {
	var entryID int64
	err = pgx.BeginFunc(ctx, rt.pool, func(tx pgx.Tx) error {
		var jobID [16]byte
		err := tx.QueryRow(ctx, `SELECT id, job_id FROM outbox
 WHERE kind = 'dispatch' AND published_at IS NULL AND available_at <= now()
 ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`).Scan(&entryID, &jobID)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		task, err = rt.claimJob(ctx, tx, jobID)
		if err != nil {
			return err
		}
		consumed = true
		_, err = tx.Exec(ctx, `UPDATE outbox SET published_at = now(), attempts = attempts + 1,
       last_error = NULL WHERE id = $1`, entryID)
		return err
	})
	if err != nil {
		task, consumed = nil, false
		if entryID != 0 {
			rt.backoff(ctx, entryID, err)
		}
		return nil, false, fmt.Errorf("jobs: Claim: %w", err)
	}
	return task, consumed, nil
}

// backoff vermerkt einen technischen Claim-Fehler am Eintrag.
func (rt *Runtime) backoff(ctx context.Context, entryID int64, cause error) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	class := fmt.Sprintf("%T", errors.Unwrap(cause))
	if class == "<nil>" {
		class = fmt.Sprintf("%T", cause)
	}
	class = strings.TrimPrefix(class, "*")
	if len(class) > 80 {
		class = class[:80]
	}
	_, _ = rt.pool.Exec(ctx, `UPDATE outbox SET attempts = attempts + 1, last_error = $2,
       available_at = now() + least(60, power(2, least(attempts + 1, 6)))::int * interval '1 second'
 WHERE id = $1 AND published_at IS NULL`, entryID, class)
}

// claimJob ist runtime.claim innerhalb der Claim-Transaktion.
func (rt *Runtime) claimJob(ctx context.Context, tx pgx.Tx, jobID [16]byte) (*Task, error) {
	var (
		state, tool, inputKey                string
		options                              []byte
		deleted, cancelReq, expired, noTries bool
		reserved, inputSize                  int64
	)
	err := tx.QueryRow(ctx, `SELECT state, tool, options, input_storage_key,
       deleted_at IS NOT NULL, cancel_requested_at IS NOT NULL, expires_at <= now(),
       attempts >= max_attempts, reserved_bytes, input_size
  FROM jobs WHERE id = $1 FOR UPDATE`, jobID).Scan(&state, &tool, &options, &inputKey,
		&deleted, &cancelReq, &expired, &noTries, &reserved, &inputSize)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if state != "queued" || deleted || cancelReq || expired {
		return nil, nil
	}
	if noTries {
		if err := failQueued(ctx, tx, jobID, "worker-failed"); err != nil {
			return nil, err
		}
		return nil, nil
	}
	working := rt.cfg.ImageMaxOutputBytes
	if tool == "markdown-pdf" {
		working = rt.cfg.MarkdownMaxOutputBytes
	}
	if tool == "audio-convert" {
		working = rt.cfg.AudioMaxOutputBytes
	}
	if tool == "pdf-compress" {
		// Bereits veröffentlichte Stufen zählen gegen das Gesamtbudget.
		working = max(0, rt.cfg.PDFMaxResultsTotalBytes-(reserved-inputSize))
	}
	ok, err := reserveBytes(ctx, tx, working, rt.cfg.StorageBudgetBytes)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, failQueued(ctx, tx, jobID, "storage-full")
	}
	lease := store.NewID()
	if _, err := tx.Exec(ctx, `UPDATE jobs SET state = 'running', phase = 'analyze',
       lease_token = $2, working_bytes = $3,
       lease_expires_at = now() + $4 * interval '1 microsecond',
       heartbeat_at = now(), started_at = now(), updated_at = now(),
       attempts = attempts + 1, version = version + 1
 WHERE id = $1`, jobID, lease, working, rt.cfg.Lease.Microseconds()); err != nil {
		return nil, err
	}
	// Nicht veröffentlichte Ergebnisse zurücksetzen; veröffentlichte
	// (PDF-Stufen) bleiben unangetastet.
	rows, err := tx.Query(ctx, `UPDATE job_results SET state = 'pending', error_code = NULL
 WHERE job_id = $1 AND state <> 'succeeded' RETURNING id, coalesce(level, ''), ordinal`, jobID)
	if err != nil {
		return nil, err
	}
	type pending struct {
		r       TaskResult
		ordinal int16
	}
	list, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (pending, error) {
		var p pending
		err := row.Scan(&p.r.ID, &p.r.Level, &p.ordinal)
		return p, err
	})
	if err != nil {
		return nil, err
	}
	task := &Task{JobID: jobID, Lease: lease, Tool: tool, Options: json.RawMessage(options), InputKey: inputKey, OutputBudget: working}
	for _, p := range sortByOrdinal(list, func(p pending) int16 { return p.ordinal }) {
		p.r.Key = storage.ResultKey(jobID, p.r.ID, lease)
		task.Results = append(task.Results, p.r)
	}
	return task, nil
}

// Failed claims are terminal, including their open result rows. Previously
// published PDF variants remain downloadable and imply partial success.
func failQueued(ctx context.Context, tx pgx.Tx, id [16]byte, code string) error {
	var some bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM job_results WHERE job_id=$1 AND state='succeeded')`, id).Scan(&some); err != nil {
		return err
	}
	state := "failed"
	var jobCode *string = &code
	if some {
		state = "partially_succeeded"
		jobCode = nil
	}
	if _, err := tx.Exec(ctx, `UPDATE jobs SET state=$2,error_code=$3,phase=NULL,progress=NULL,finished_at=now(),updated_at=now(),version=version+1 WHERE id=$1`, id, state, jobCode); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `UPDATE job_results SET state='failed',error_code=$2 WHERE job_id=$1 AND state IN ('pending','running')`, id, code)
	return err
}

func sortByOrdinal[T any](items []T, ordinal func(T) int16) []T {
	for i := 1; i < len(items); i++ {
		for j := i; j > 0 && ordinal(items[j]) < ordinal(items[j-1]); j-- {
			items[j], items[j-1] = items[j-1], items[j]
		}
	}
	return items
}

// Heartbeat verlängert die Lease (runtime.heartbeat); false = Lease
// verloren oder Abbruch angefordert → Verarbeitung beenden.
func (rt *Runtime) Heartbeat(ctx context.Context, t *Task) (bool, error) {
	tag, err := rt.pool.Exec(ctx, `UPDATE jobs SET heartbeat_at = now(),
       lease_expires_at = now() + $3 * interval '1 microsecond'
 WHERE `+ownedSQL+` AND cancel_requested_at IS NULL`, t.JobID, t.Lease, rt.cfg.Lease.Microseconds())
	if err != nil {
		return false, fmt.Errorf("jobs: Heartbeat: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

// lockOwned sperrt den eigenen, nicht abgebrochenen Auftrag und setzt
// updated_at; ok=false, wenn die Lease nicht mehr gilt.
func lockOwned(ctx context.Context, tx pgx.Tx, t *Task) (working int64, ok bool, err error) {
	err = tx.QueryRow(ctx, `UPDATE jobs SET updated_at = now()
 WHERE `+ownedSQL+` AND cancel_requested_at IS NULL RETURNING working_bytes`, t.JobID, t.Lease).Scan(&working)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	return working, err == nil, err
}

// Progress setzt phase und progress (Ereignis progress). Leere Phase =
// "variant" wie in Python.
func (rt *Runtime) Progress(ctx context.Context, t *Task, phase string, progress json.RawMessage) (bool, error) {
	if phase == "" {
		phase = "variant"
	}
	return rt.ownedUpdate(ctx, t, `UPDATE jobs SET phase = $3, progress = $4 WHERE id = $1 AND lease_token = $2`,
		phase, nullJSON(progress))
}

// Analysis speichert die Analyse (Ereignis analysis).
func (rt *Runtime) Analysis(ctx context.Context, t *Task, analysis json.RawMessage) (bool, error) {
	return rt.ownedUpdate(ctx, t, `UPDATE jobs SET analysis = $3 WHERE id = $1 AND lease_token = $2`,
		nullJSON(analysis))
}

func nullJSON(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	return string(raw)
}

func (rt *Runtime) ownedUpdate(ctx context.Context, t *Task, sql string, args ...any) (bool, error) {
	var ok bool
	err := pgx.BeginFunc(ctx, rt.pool, func(tx pgx.Tx) error {
		var err error
		if _, ok, err = lockOwned(ctx, tx, t); err != nil || !ok {
			return err
		}
		_, err = tx.Exec(ctx, sql, append([]any{t.JobID, t.Lease}, args...)...)
		return err
	})
	if err != nil {
		return false, fmt.Errorf("jobs: Ereignis: %w", err)
	}
	return ok, nil
}

// lockResult sperrt eine noch nicht veröffentlichte Ergebniszeile des Auftrags.
func lockResult(ctx context.Context, tx pgx.Tx, t *Task, resultID [16]byte) (bool, error) {
	var state string
	err := tx.QueryRow(ctx, `SELECT state FROM job_results WHERE id = $1 AND job_id = $2 FOR UPDATE`,
		resultID, t.JobID).Scan(&state)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return state != "succeeded", nil
}

// FailResult markiert ein Ergebnis als fehlgeschlagen (Ereignis error).
// false = Lease verloren, Abbruch oder Ergebnis unbekannt/bereits
// veröffentlicht → Verarbeitung beenden (wie runner.py).
func (rt *Runtime) FailResult(ctx context.Context, t *Task, resultID [16]byte, code string) (bool, error) {
	var ok bool
	err := pgx.BeginFunc(ctx, rt.pool, func(tx pgx.Tx) error {
		var err error
		if _, ok, err = lockOwned(ctx, tx, t); err != nil || !ok {
			return err
		}
		if ok, err = lockResult(ctx, tx, t, resultID); err != nil || !ok {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE job_results SET state = 'failed', error_code = $2 WHERE id = $1`, resultID, code)
		return err
	})
	if err != nil {
		return false, fmt.Errorf("jobs: Ergebnisfehler: %w", err)
	}
	return ok, nil
}

// PublishResult veröffentlicht eine fertige Ergebnisdatei (Ereignis result):
// nur mit gültiger Lease, ohne Abbruchwunsch, für ein noch nicht
// veröffentlichtes Ergebnis. size ist die vom Worker im Dateisystem
// gemessene Größe. Sie wird aus der Arbeitsreserve in die dauerhafte
// Reserve des Auftrags übertragen; übersteigt sie die Arbeitsreserve (bei
// PDF: Gesamtbudget abzüglich früherer Stufen), wird das Ergebnis
// failed(result-too-large) und false geliefert. Bei false löscht der Worker
// die eigene Datei.
func (rt *Runtime) PublishResult(ctx context.Context, t *Task, resultID [16]byte, size int64, details json.RawMessage) (bool, error) {
	key, known := "", false
	for _, r := range t.Results {
		if r.ID == resultID {
			key, known = r.Key, true
		}
	}
	if !known {
		return false, nil
	}
	var width, height *int64
	// Nur Bilder haben Abmessungen; Audio und PDF lassen input_width/height NULL.
	if t.Tool != "pdf-compress" && t.Tool != "audio-convert" && t.Tool != "markdown-pdf" && t.Tool != "image-pdf" {
		var err error
		if width, height, err = sourceSize(details); err != nil {
			return false, err
		}
	}
	var ok bool
	err := pgx.BeginFunc(ctx, rt.pool, func(tx pgx.Tx) error {
		working, owned, err := lockOwned(ctx, tx, t)
		if err != nil || !owned {
			return err
		}
		if ok, err = lockResult(ctx, tx, t, resultID); err != nil || !ok {
			return err
		}
		if size < 0 || size > working {
			ok = false
			_, err = tx.Exec(ctx, `UPDATE job_results SET state = 'failed', error_code = 'result-too-large'
 WHERE id = $1`, resultID)
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE job_results SET storage_key = $2, size = $3, details = $4,
       state = 'succeeded' WHERE id = $1`, resultID, key, size, nullJSON(details)); err != nil {
			return err
		}
		if t.Tool == "pdf-compress" {
			_, err = tx.Exec(ctx, `UPDATE jobs SET working_bytes = working_bytes - $2,
       reserved_bytes = reserved_bytes + $2 WHERE id = $1`, t.JobID, size)
		} else {
			_, err = tx.Exec(ctx, `UPDATE jobs SET working_bytes = working_bytes - $2,
       reserved_bytes = reserved_bytes + $2, input_width = $3, input_height = $4 WHERE id = $1`,
				t.JobID, size, width, height)
		}
		return err
	})
	if err != nil {
		return false, fmt.Errorf("jobs: Veröffentlichung: %w", err)
	}
	return ok, nil
}

// sourceSize liest sourceWidth/sourceHeight aus details (fehlend → NULL,
// wie details.get in Python).
func sourceSize(details json.RawMessage) (w, h *int64, err error) {
	if len(details) == 0 {
		return nil, nil, errors.New("jobs: details fehlen")
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(details, &obj); err != nil {
		return nil, nil, errors.New("jobs: details sind kein Objekt")
	}
	read := func(name string) *int64 {
		var v int64
		if raw, ok := obj[name]; ok && json.Unmarshal(raw, &v) == nil && v >= 0 && v <= 1<<31-1 {
			return &v
		}
		return nil
	}
	return read("sourceWidth"), read("sourceHeight"), nil
}

// IsPublished prüft nach einem unklaren Veröffentlichungsfehler, ob das
// Ergebnis mit diesem Schlüssel tatsächlich committet ist.
func (rt *Runtime) IsPublished(ctx context.Context, t *Task, resultID [16]byte) (bool, error) {
	var key *string
	err := rt.pool.QueryRow(ctx, `SELECT storage_key FROM job_results
 WHERE id = $1 AND job_id = $2 AND state = 'succeeded'`, resultID, t.JobID).Scan(&key)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	for _, r := range t.Results {
		if r.ID == resultID {
			return key != nil && *key == r.Key, nil
		}
	}
	return false, nil
}

// Finish schließt den Versuch ab (runtime.finish): nur mit gültiger Lease
// des Auftrags (Ablauf von expires_at und Abbruchwunsch sind hier erlaubt).
// Offene Ergebnisse → cancelled (Abbruch/Ablauf) bzw. failed(errorCode,
// Standard worker-failed); Endzustand expired > cancelled > succeeded >
// partially_succeeded > failed; Arbeitsreserve freigeben.
func (rt *Runtime) Finish(ctx context.Context, t *Task, errorCode string) error {
	err := pgx.BeginFunc(ctx, rt.pool, func(tx pgx.Tx) error {
		var working int64
		var cancelled, expired bool
		err := tx.QueryRow(ctx, `SELECT working_bytes,
       cancel_requested_at IS NOT NULL OR deleted_at IS NOT NULL, expires_at <= now()
  FROM jobs WHERE id = $1 AND state = 'running' AND lease_token = $2
   AND lease_expires_at > now() AND deleted_at IS NULL FOR UPDATE`, t.JobID, t.Lease).Scan(&working, &cancelled, &expired)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		resultCode := errorCode
		if resultCode == "" {
			resultCode = "worker-failed"
		}
		if cancelled || expired {
			_, err = tx.Exec(ctx, `UPDATE job_results SET state = 'cancelled', error_code = NULL
 WHERE job_id = $1 AND state NOT IN ('succeeded', 'failed', 'cancelled')`, t.JobID)
		} else {
			_, err = tx.Exec(ctx, `UPDATE job_results SET state = 'failed', error_code = $2
 WHERE job_id = $1 AND state NOT IN ('succeeded', 'failed', 'cancelled')`, t.JobID, resultCode)
		}
		if err != nil {
			return err
		}
		var total, ok int
		var firstCode *string
		if err := tx.QueryRow(ctx, `SELECT count(*), count(*) FILTER (WHERE state = 'succeeded'),
       (SELECT error_code FROM job_results WHERE job_id = $1 AND error_code IS NOT NULL
         ORDER BY ordinal LIMIT 1)
  FROM job_results WHERE job_id = $1`, t.JobID).Scan(&total, &ok, &firstCode); err != nil {
			return err
		}
		var state string
		switch {
		case expired:
			state = "expired"
		case cancelled:
			state = "cancelled"
		case ok == total:
			state = "succeeded"
		case ok > 0:
			state = "partially_succeeded"
		default:
			state = "failed"
		}
		var jobCode *string
		if state == "failed" {
			code := errorCode
			if code == "" && firstCode != nil {
				code = *firstCode
			}
			if code == "" {
				code = "worker-failed"
			}
			jobCode = &code
		}
		if _, err := tx.Exec(ctx, `UPDATE jobs SET state = $2, error_code = $3, phase = NULL,
       progress = NULL, finished_at = now(), updated_at = now(), lease_token = NULL,
       lease_expires_at = NULL, version = version + 1, working_bytes = 0 WHERE id = $1`,
			t.JobID, state, jobCode); err != nil {
			return err
		}
		return releaseBytes(ctx, tx, working)
	})
	if err != nil {
		return fmt.Errorf("jobs: Abschluss: %w", err)
	}
	return nil
}

// Recover holt Aufträge mit abgelaufener Lease zurück (runtime.recover), in
// einer Transaktion mit SKIP LOCKED:
//
//   - Die Arbeitsreserve wandert in stale_attempts (reap_after = now +
//     max(Timeouts) + 10 s) und wird NICHT freigegeben: Reste des alten
//     Versuchs können noch existieren; erst der Cleanup gibt sie frei.
//   - Zustand: expires_at erreicht → expired; Abbruch/Löschung → cancelled;
//     Versuche erschöpft → partially_succeeded (mit veröffentlichtem
//     Ergebnis) bzw. failed(worker-failed); sonst queued + neuer
//     Dispatch-Eintrag.
//   - Offene Ergebnisse: pending (queued), cancelled oder
//     failed(worker-failed).
func (rt *Runtime) Recover(ctx context.Context) (int, error) {
	count := 0
	err := pgx.BeginFunc(ctx, rt.pool, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT id, lease_token, working_bytes, expires_at <= now(),
       cancel_requested_at IS NOT NULL OR deleted_at IS NOT NULL, attempts >= max_attempts,
       EXISTS (SELECT 1 FROM job_results r WHERE r.job_id = jobs.id AND r.state = 'succeeded')
  FROM jobs WHERE state = 'running' AND lease_expires_at <= now()
  FOR UPDATE SKIP LOCKED`)
		if err != nil {
			return err
		}
		type stale struct {
			id, lease                         [16]byte
			working                           int64
			expired, cancelled, noTries, some bool
		}
		list, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (stale, error) {
			var s stale
			err := row.Scan(&s.id, &s.lease, &s.working, &s.expired, &s.cancelled, &s.noTries, &s.some)
			return s, err
		})
		if err != nil {
			return err
		}
		for _, s := range list {
			if _, err := tx.Exec(ctx, `INSERT INTO stale_attempts (lease_token, job_id, reserved_bytes, reap_after)
VALUES ($1, $2, $3, now() + $4 * interval '1 microsecond')`,
				s.lease, s.id, s.working, rt.cfg.staleGrace().Microseconds()); err != nil {
				return err
			}
			state, resultState, jobCode, resultCode := "queued", "pending", (*string)(nil), (*string)(nil)
			workerFailed := "worker-failed"
			switch {
			case s.expired:
				state, resultState = "expired", "failed"
			case s.cancelled:
				state, resultState = "cancelled", "cancelled"
			case s.noTries && s.some:
				state, resultState, resultCode = "partially_succeeded", "failed", &workerFailed
			case s.noTries:
				state, resultState, jobCode, resultCode = "failed", "failed", &workerFailed, &workerFailed
			}
			if _, err := tx.Exec(ctx, `UPDATE jobs SET working_bytes = 0, lease_token = NULL,
       lease_expires_at = NULL, phase = NULL, progress = NULL, state = $2,
       error_code = CASE WHEN $2 IN ('failed', 'partially_succeeded') THEN $3 ELSE error_code END,
       version = version + 1, updated_at = now(),
       finished_at = CASE WHEN $2 = 'queued' THEN finished_at ELSE now() END
 WHERE id = $1`, s.id, state, jobCode); err != nil {
				return err
			}
			if state == "queued" {
				if _, err := tx.Exec(ctx, `INSERT INTO outbox (kind, job_id) VALUES ('dispatch', $1)`, s.id); err != nil {
					return err
				}
			}
			if _, err := tx.Exec(ctx, `UPDATE job_results SET state = $2, error_code = $3
 WHERE job_id = $1 AND state IN ('pending', 'running')`, s.id, resultState, resultCode); err != nil {
				return err
			}
			count++
		}
		return nil
	})
	if err != nil {
		return 0, fmt.Errorf("jobs: Recovery: %w", err)
	}
	return count, nil
}
