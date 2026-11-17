package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Besitzergebundene Auftragsabfragen (app/jobs/queries.py, api/results.py).
// Fremde, unbekannte und gelöschte Aufträge sind nicht unterscheidbar.

var (
	ErrJobNotFound    = errors.New("store: Auftrag nicht gefunden")  // 404 job-not-found
	ErrJobExpired     = errors.New("store: Auftrag abgelaufen")      // 410 job-expired
	ErrResultNotFound = errors.New("store: Ergebnis nicht gefunden") // 404 result-not-found
)

// Job ist eine Zeile aus jobs (ohne Lease-/Arbeitsfelder des Workers).
type Job struct {
	ID                [16]byte
	SessionID         [16]byte
	Tool              string
	State             string
	Phase             *string
	Options           json.RawMessage
	InputName         string
	InputSize         int64
	InputFormat       string
	InputWidth        *int32
	InputHeight       *int32
	IdempotencyKey    *string
	Fingerprint       []byte
	Version           int32
	Attempts          int32
	MaxAttempts       int32
	CancelRequestedAt *time.Time
	DeletedAt         *time.Time
	CreatedAt         time.Time
	UpdatedAt         time.Time
	AcceptedAt        time.Time
	StartedAt         *time.Time
	FinishedAt        *time.Time
	ExpiresAt         time.Time
	ErrorCode         *string
	Progress          json.RawMessage // nil = NULL
	Analysis          json.RawMessage // nil = NULL
	ReservedBytes     int64
	DownloadUntil     *time.Time
}

// Result ist eine Zeile aus job_results.
type Result struct {
	ID           [16]byte
	Ordinal      int16
	Level        *string
	State        string
	StorageKey   *string
	Size         *int64
	MIME         string
	DownloadName string
	Details      json.RawMessage // nil = NULL
	ErrorCode    *string
}

// LoadedJob ist ein Auftrag mit seinen Ergebnissen, nach ordinal sortiert.
type LoadedJob struct {
	Job     Job
	Results []Result
}

const jobColumns = `id, session_id, tool, state, phase, options, input_name, input_size,
       input_format, input_width, input_height, idempotency_key, fingerprint, version,
       attempts, max_attempts, cancel_requested_at, deleted_at, created_at, updated_at,
       accepted_at, started_at, finished_at, expires_at, error_code, progress, analysis,
       reserved_bytes, download_until`

func scanJob(row pgx.Row) (Job, error) {
	var j Job
	var options, progress, analysis []byte
	err := row.Scan(&j.ID, &j.SessionID, &j.Tool, &j.State, &j.Phase, &options, &j.InputName,
		&j.InputSize, &j.InputFormat, &j.InputWidth, &j.InputHeight, &j.IdempotencyKey,
		&j.Fingerprint, &j.Version, &j.Attempts, &j.MaxAttempts, &j.CancelRequestedAt,
		&j.DeletedAt, &j.CreatedAt, &j.UpdatedAt, &j.AcceptedAt, &j.StartedAt, &j.FinishedAt,
		&j.ExpiresAt, &j.ErrorCode, &progress, &analysis, &j.ReservedBytes, &j.DownloadUntil)
	if err != nil {
		return Job{}, err
	}
	j.Options, j.Progress, j.Analysis = rawJSON(options), rawJSON(progress), rawJSON(analysis)
	return j, nil
}

func rawJSON(b []byte) json.RawMessage {
	if b == nil {
		return nil
	}
	return json.RawMessage(b)
}

// LoadJob lädt einen nicht gelöschten Auftrag der Sitzung samt Ergebnissen
// (queries.load_job). Fehlt er: ErrJobNotFound.
func LoadJob(ctx context.Context, db DB, jobID, sessionID [16]byte) (LoadedJob, error) {
	job, err := scanJob(db.QueryRow(ctx, `SELECT `+jobColumns+` FROM jobs
WHERE id = $1 AND session_id = $2 AND deleted_at IS NULL`, jobID, sessionID))
	if errors.Is(err, pgx.ErrNoRows) {
		return LoadedJob{}, ErrJobNotFound
	}
	if err != nil {
		return LoadedJob{}, fmt.Errorf("store: Auftrag laden: %w", err)
	}
	results, err := loadResults(ctx, db, jobID)
	if err != nil {
		return LoadedJob{}, err
	}
	return LoadedJob{Job: job, Results: results}, nil
}

func loadResults(ctx context.Context, db DB, jobID [16]byte) ([]Result, error) {
	rows, err := db.Query(ctx, `SELECT id, ordinal, level, state, storage_key, size, mime,
       download_name, details, error_code
  FROM job_results WHERE job_id = $1 ORDER BY ordinal`, jobID)
	if err != nil {
		return nil, fmt.Errorf("store: Ergebnisse laden: %w", err)
	}
	results, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Result, error) {
		var r Result
		var details []byte
		err := row.Scan(&r.ID, &r.Ordinal, &r.Level, &r.State, &r.StorageKey, &r.Size, &r.MIME,
			&r.DownloadName, &details, &r.ErrorCode)
		r.Details = rawJSON(details)
		return r, err
	})
	if err != nil {
		return nil, fmt.Errorf("store: Ergebnisse laden: %w", err)
	}
	return results, nil
}

// Expired: Zustand expired oder Ablaufzeit erreicht (queries.is_expired).
func (j *Job) Expired(now time.Time) bool {
	return j.State == "expired" || !j.ExpiresAt.After(now)
}

// JobView ist die fachliche Sicht für GET /jobs/{id} (queries.to_view); die
// API macht daraus ihr DTO.
type JobView struct {
	ID              [16]byte
	Tool            string
	State           string  // abgelaufene Aufträge zeigen "expired"
	Phase           *string // nur bei running
	CreatedAt       time.Time
	UpdatedAt       time.Time
	ExpiresAt       time.Time
	InputName       string
	InputSize       int64
	InputFormat     string
	InputWidth      *int32
	InputHeight     *int32
	Progress        json.RawMessage // nur bei running
	Analysis        json.RawMessage
	Results         []ResultView
	ErrorCode       *string
	CancelRequested bool
}

// ResultView: Downloadable ersetzt die URL; die API baut daraus
// /api/v1/jobs/{job}/results/{result}.
type ResultView struct {
	ID           [16]byte
	Level        *string
	State        string
	Size         *int64
	MIME         string
	DownloadName string
	Downloadable bool
	Details      json.RawMessage
	ErrorCode    *string
}

// View wendet die Ablaufregeln an: abgelaufene Aufträge zeigen expired und
// keine Downloads, auch bevor der Cleanup sie umgestellt hat.
func (l LoadedJob) View(now time.Time) JobView {
	j := l.Job
	expired := j.Expired(now)
	state := j.State
	if expired {
		state = "expired"
	}
	v := JobView{
		ID: j.ID, Tool: j.Tool, State: state, CreatedAt: j.CreatedAt, UpdatedAt: j.UpdatedAt,
		ExpiresAt: j.ExpiresAt, InputName: j.InputName, InputSize: j.InputSize,
		InputFormat: j.InputFormat, InputWidth: j.InputWidth, InputHeight: j.InputHeight,
		Analysis: j.Analysis, ErrorCode: j.ErrorCode, CancelRequested: j.CancelRequestedAt != nil,
		Results: make([]ResultView, 0, len(l.Results)),
	}
	if state == "running" {
		if j.Phase != nil && *j.Phase != "" {
			v.Phase = j.Phase
		}
		v.Progress = j.Progress
	}
	for _, r := range l.Results {
		v.Results = append(v.Results, ResultView{
			ID: r.ID, Level: r.Level, State: r.State, Size: r.Size, MIME: r.MIME,
			DownloadName: r.DownloadName, Downloadable: r.State == "succeeded" && !expired,
			Details: r.Details, ErrorCode: r.ErrorCode,
		})
	}
	return v
}

// CancelOutcome ist das Feld cancellation der Antwort.
type CancelOutcome string

const (
	CancelCompleted     CancelOutcome = "completed"
	CancelRequested     CancelOutcome = "requested"
	CancelNotApplicable CancelOutcome = "not-applicable"
)

// Cancel bricht einen Auftrag der Sitzung ab (api/results.cancel_job +
// runtime.cancel): bereits cancelled → completed; nicht queued/running oder
// abgelaufen → not-applicable; queued → sofort cancelled (offene Ergebnisse
// ebenso) → completed; running → Abbruchwunsch → requested. Danach wird der
// Auftrag neu gelesen.
func Cancel(ctx context.Context, pool *pgxpool.Pool, sessionID, jobID [16]byte) (CancelOutcome, LoadedJob, error) {
	var outcome CancelOutcome
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		var state string
		var expired bool
		err := tx.QueryRow(ctx, `SELECT state, expires_at <= now() FROM jobs
WHERE id = $1 AND session_id = $2 AND deleted_at IS NULL FOR UPDATE`, jobID, sessionID).Scan(&state, &expired)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrJobNotFound
		}
		if err != nil {
			return err
		}
		switch {
		case state == "cancelled":
			outcome = CancelCompleted
			return nil
		case (state != "queued" && state != "running") || expired:
			outcome = CancelNotApplicable
			return nil
		case state == "queued":
			if _, err := tx.Exec(ctx, `UPDATE jobs SET cancel_requested_at = now(), version = version + 1,
       state = 'cancelled', phase = NULL, finished_at = now() WHERE id = $1`, jobID); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `UPDATE job_results SET state = 'cancelled'
WHERE job_id = $1 AND state IN ('pending', 'running')`, jobID); err != nil {
				return err
			}
			outcome = CancelCompleted
			return nil
		default:
			_, err := tx.Exec(ctx, `UPDATE jobs SET cancel_requested_at = now(), version = version + 1
WHERE id = $1`, jobID)
			outcome = CancelRequested
			return err
		}
	})
	if errors.Is(err, ErrJobNotFound) {
		return "", LoadedJob{}, err
	}
	if err != nil {
		return "", LoadedJob{}, fmt.Errorf("store: Abbruch: %w", err)
	}
	loaded, err := LoadJob(ctx, pool, jobID, sessionID)
	if err != nil {
		return "", LoadedJob{}, err
	}
	return outcome, loaded, nil
}

// MarkDeleted sperrt den Auftrag sofort und plant die physische Löschung
// (queries.mark_deleted): deleted_at, bei queued/running zusätzlich
// cancel_requested_at, version+1, updated_at und ein delete-Outbox-Eintrag
// in derselben Transaktion. Fehlt der Auftrag: ErrJobNotFound.
func MarkDeleted(ctx context.Context, pool *pgxpool.Pool, sessionID, jobID [16]byte) error {
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE jobs SET deleted_at = now(),
       cancel_requested_at = CASE WHEN state IN ('queued', 'running')
                                  THEN coalesce(cancel_requested_at, now())
                                  ELSE cancel_requested_at END,
       version = version + 1, updated_at = now()
 WHERE id = $1 AND session_id = $2 AND deleted_at IS NULL`, jobID, sessionID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrJobNotFound
		}
		_, err = tx.Exec(ctx, `INSERT INTO outbox (kind, job_id) VALUES ('delete', $1)`, jobID)
		return err
	})
	if err != nil && !errors.Is(err, ErrJobNotFound) {
		return fmt.Errorf("store: Löschen: %w", err)
	}
	return err
}

// Download beschreibt eine freigegebene Ergebnisdatei.
type Download struct {
	StorageKey   string
	Size         int64
	MIME         string
	DownloadName string
	// Deadline = Datenbankzeit + maxDuration, gleich download_until. Die API
	// begrenzt das Streaming zusätzlich mit einem eigenen Timer.
	Deadline time.Time
}

// LeaseDownload prüft Besitz und Zustand und committet die Download-Lease
// (jobs.download_until), bevor gestreamt wird (api/results.download):
// gelöscht/fremd → ErrJobNotFound; abgelaufen → ErrJobExpired; Ergebnis
// fehlt/nicht succeeded → ErrResultNotFound. Fehlt danach die Datei, meldet
// die API ebenfalls result-not-found.
func LeaseDownload(ctx context.Context, pool *pgxpool.Pool, sessionID, jobID, resultID [16]byte, maxDuration time.Duration) (Download, error) {
	var d Download
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		var state string
		var expired bool
		var now time.Time
		err := tx.QueryRow(ctx, `SELECT state, expires_at <= now(), now() FROM jobs
WHERE id = $1 AND session_id = $2 AND deleted_at IS NULL FOR UPDATE`, jobID, sessionID).Scan(&state, &expired, &now)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrJobNotFound
		}
		if err != nil {
			return err
		}
		if expired || state == "expired" {
			return ErrJobExpired
		}
		var key *string
		var size *int64
		err = tx.QueryRow(ctx, `SELECT storage_key, size, mime, download_name FROM job_results
WHERE id = $1 AND job_id = $2 AND state = 'succeeded'`, resultID, jobID).Scan(&key, &size, &d.MIME, &d.DownloadName)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && (key == nil || size == nil)) {
			return ErrResultNotFound
		}
		if err != nil {
			return err
		}
		d.StorageKey, d.Size = *key, *size
		return tx.QueryRow(ctx, `UPDATE jobs SET download_until = now() + $2 * interval '1 microsecond'
WHERE id = $1 RETURNING download_until`, jobID, micros(maxDuration)).Scan(&d.Deadline)
	})
	switch {
	case errors.Is(err, ErrJobNotFound), errors.Is(err, ErrJobExpired), errors.Is(err, ErrResultNotFound):
		return Download{}, err
	case err != nil:
		return Download{}, fmt.Errorf("store: Download-Lease: %w", err)
	}
	return d, nil
}

// Gründe, aus denen ein Auftrag nicht ins ZIP-Archiv gelangt (ArchiveJob.Skipped).
const (
	SkipNotFound = "job-not-found" // unbekannt, fremd oder gelöscht
	SkipExpired  = "job-expired"
	SkipFailed   = "job-failed"  // beendet ohne herunterladbares Ergebnis
	SkipPending  = "job-pending" // noch in Verarbeitung
)

// ArchiveJob ist ein angefragter Auftrag eines Archivs: entweder mit
// herunterladbaren Ergebnissen oder mit einem Überspringgrund.
type ArchiveJob struct {
	ID        [16]byte
	InputName string // leer bei SkipNotFound
	Skipped   string // leer = Ergebnisse enthalten
	Results   []Download
}

// LeaseArchive prüft Besitz und Zustand aller Aufträge in einer Transaktion
// und verlängert die Download-Lease (jobs.download_until) jedes Auftrags mit
// herunterladbaren Ergebnissen, bevor gestreamt wird – wie LeaseDownload,
// aber ohne Fehler für einzelne Aufträge: Sie erscheinen mit Skipped. Die
// Reihenfolge entspricht jobIDs.
func LeaseArchive(ctx context.Context, pool *pgxpool.Pool, sessionID [16]byte, jobIDs [][16]byte, maxDuration time.Duration) ([]ArchiveJob, error) {
	out := make([]ArchiveJob, 0, len(jobIDs))
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		out = out[:0]
		for _, id := range jobIDs {
			item := ArchiveJob{ID: id}
			var state string
			var expired bool
			err := tx.QueryRow(ctx, `SELECT input_name, state, expires_at <= now() FROM jobs
WHERE id = $1 AND session_id = $2 AND deleted_at IS NULL FOR UPDATE`, id, sessionID).Scan(&item.InputName, &state, &expired)
			switch {
			case errors.Is(err, pgx.ErrNoRows):
				item.Skipped = SkipNotFound
			case err != nil:
				return err
			case expired || state == "expired":
				item.Skipped = SkipExpired
			case state == "queued" || state == "running":
				item.Skipped = SkipPending
			default:
				rows, err := tx.Query(ctx, `SELECT storage_key, size, mime, download_name FROM job_results
WHERE job_id = $1 AND state = 'succeeded' AND storage_key IS NOT NULL AND size IS NOT NULL ORDER BY ordinal`, id)
				if err != nil {
					return err
				}
				for rows.Next() {
					var d Download
					if err := rows.Scan(&d.StorageKey, &d.Size, &d.MIME, &d.DownloadName); err != nil {
						rows.Close()
						return err
					}
					item.Results = append(item.Results, d)
				}
				rows.Close()
				if err := rows.Err(); err != nil {
					return err
				}
				if len(item.Results) == 0 {
					item.Skipped = SkipFailed
					break
				}
				var deadline time.Time
				if err := tx.QueryRow(ctx, `UPDATE jobs SET download_until = now() + $2 * interval '1 microsecond'
WHERE id = $1 RETURNING download_until`, id, micros(maxDuration)).Scan(&deadline); err != nil {
					return err
				}
				for i := range item.Results {
					item.Results[i].Deadline = deadline
				}
			}
			out = append(out, item)
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("store: Archiv-Lease: %w", err)
	}
	return out, nil
}
