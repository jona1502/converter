package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"miconverter/server/internal/storage"
	"miconverter/server/internal/store"
)

// AdmissionLockKey ist derselbe pg_advisory_xact_lock-Schlüssel wie in
// app/jobs/admission.py („conv“ als Zahl).
const AdmissionLockKey int64 = 0x636F6E76

// IdempotencyConstraint ist der eindeutige Index (session_id, idempotency_key).
const IdempotencyConstraint = "uq_jobs_session_id_idempotency_key"

// cleanupTimeout begrenzt Aufräumarbeiten, die auch nach Abbruch des
// Request-Contexts noch laufen müssen.
const cleanupTimeout = 10 * time.Second

// Limits sind die für die Annahme nötigen Einstellungen (gleiche Bedeutung
// und Defaults wie CONVERTER_* in app/core/config.py).
type Limits struct {
	MarkdownMaxInputBytes int64
	ImageMaxInputBytes    int64         // 52_428_800
	PDFMaxInputBytes      int64         // 100_000_000
	AudioMaxInputBytes    int64         // 104_857_600
	StorageBudgetBytes    int64         // 5_000_000_000
	SessionMaxActiveJobs  int           // 3
	GlobalMaxActiveJobs   int           // 50
	UploadMax             time.Duration // 600 s, auch Lebensdauer der Reservierung
	JobTTL                time.Duration // 3600 s
	JobMaxAttempts        int           // 3
}

// MaxUploadInputBytes = max(Bild, PDF, Audio, Markdown); so viel reserviert jede
// Annahme, weil das Werkzeug erst nach dem Lesen der Optionen feststeht.
func (l Limits) MaxUploadInputBytes() int64 {
	return max(l.ImageMaxInputBytes, l.PDFMaxInputBytes, l.AudioMaxInputBytes, l.MarkdownMaxInputBytes)
}

func (l Limits) validate() error {
	if l.ImageMaxInputBytes <= 0 || l.PDFMaxInputBytes <= 0 || l.AudioMaxInputBytes <= 0 || l.StorageBudgetBytes <= 0 ||
		l.SessionMaxActiveJobs <= 0 || l.GlobalMaxActiveJobs <= 0 || l.UploadMax <= 0 ||
		l.JobTTL <= 0 || l.JobMaxAttempts <= 0 {
		return errors.New("jobs: Grenzwerte müssen positiv sein")
	}
	return nil
}

// Service bündelt Datenbank, Dateispeicher und Grenzwerte.
type Service struct {
	pool    *pgxpool.Pool
	storage *storage.Local
	limits  Limits
	// freeBytes ist für Tests austauschbar.
	freeBytes  func() (uint64, error)
	finalizeTx func(context.Context, func(pgx.Tx) error) error
}

// New erzeugt den Annahmedienst.
func New(pool *pgxpool.Pool, st *storage.Local, limits Limits) (*Service, error) {
	if err := limits.validate(); err != nil {
		return nil, err
	}
	return &Service{pool: pool, storage: st, limits: limits, freeBytes: st.FreeBytes,
		finalizeTx: func(ctx context.Context, fn func(pgx.Tx) error) error { return pgx.BeginFunc(ctx, pool, fn) }}, nil
}

// Reservation ist eine laufende Upload-Reservierung.
type Reservation struct {
	ID       [16]byte
	Bytes    int64
	SpoolKey string
}

// Admit legt vor dem Lesen des Bodys eine Upload-Reservierung an
// (admission.reserve_upload): freier Platz im Dateisystem, dann unter
// pg_advisory_xact_lock aktive Aufträge plus laufende Reservierungen je
// Sitzung (ErrSessionJobLimit) und global (ErrServerBusy) in einem
// Snapshot zählen und die maximale Eingabegröße im Budget reservieren
// (ErrStorageFull). Die Reservierung läuft nach Limits.UploadMax ab.
func (s *Service) Admit(ctx context.Context, sessionID [16]byte) (Reservation, error) {
	amount := s.limits.MaxUploadInputBytes()
	free, err := s.freeBytes()
	if err != nil {
		return Reservation{}, fmt.Errorf("jobs: freier Speicher: %w", err)
	}
	if free < uint64(amount) {
		return Reservation{}, ErrStorageFull
	}
	r := Reservation{ID: store.NewID(), Bytes: amount}
	r.SpoolKey = storage.SpoolKey(r.ID)
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", AdmissionLockKey); err != nil {
			return err
		}
		// Eine Anweisung = ein Snapshot: Die Annahme ersetzt eine Reservierung
		// atomar durch einen Auftrag, ohne diese Sperre zu halten.
		var mine, all int
		if err := tx.QueryRow(ctx, `
SELECT count(*) FILTER (WHERE session_id = $1), count(*) FROM (
    SELECT session_id FROM jobs
     WHERE state IN ('queued', 'running') AND deleted_at IS NULL AND expires_at > now()
    UNION ALL
    SELECT session_id FROM upload_reservations) owners`, sessionID).Scan(&mine, &all); err != nil {
			return err
		}
		if mine >= s.limits.SessionMaxActiveJobs {
			return ErrSessionJobLimit
		}
		if all >= s.limits.GlobalMaxActiveJobs {
			return ErrServerBusy
		}
		ok, err := reserveBytes(ctx, tx, amount, s.limits.StorageBudgetBytes)
		if err != nil {
			return err
		}
		if !ok {
			return ErrStorageFull
		}
		_, err = tx.Exec(ctx, `INSERT INTO upload_reservations (id, session_id, bytes, spool_key, expires_at)
VALUES ($1, $2, $3, $4, now() + $5 * interval '1 microsecond')`,
			r.ID, sessionID, amount, r.SpoolKey, s.limits.UploadMax.Microseconds())
		return err
	})
	if err != nil {
		var jerr *Error
		if errors.As(err, &jerr) {
			return Reservation{}, err
		}
		return Reservation{}, fmt.Errorf("jobs: Reservierung: %w", err)
	}
	return r, nil
}

func reserveBytes(ctx context.Context, db store.DB, amount, budget int64) (bool, error) {
	tag, err := db.Exec(ctx, `UPDATE storage_usage SET reserved_bytes = reserved_bytes + $1
WHERE id = 1 AND reserved_bytes + $1 <= $2`, amount, budget)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

func releaseBytes(ctx context.Context, db store.DB, amount int64) error {
	if amount <= 0 {
		return nil
	}
	_, err := db.Exec(ctx, `UPDATE storage_usage SET reserved_bytes = reserved_bytes - $1 WHERE id = 1`, amount)
	return err
}

// takeReservation löscht die Reservierung und liefert ihre Bytes (ok=false,
// falls schon weg). Wer die Zeile löscht, gibt die Bytes frei – API und
// Cleanup können so nie doppelt freigeben.
func takeReservation(ctx context.Context, db store.DB, id [16]byte) (int64, bool, error) {
	var amount int64
	err := db.QueryRow(ctx, `DELETE FROM upload_reservations WHERE id = $1 RETURNING bytes`, id).Scan(&amount)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	return amount, err == nil, err
}

// Release gibt eine Reservierung nach Fehler oder Abbruch frei: Spooldatei
// löschen, Reservierung entfernen, Bytes freigeben. Idempotent; läuft auch
// mit bereits abgebrochenem ctx (eigene, begrenzte Frist).
func (s *Service) Release(ctx context.Context, r Reservation) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), cleanupTimeout)
	defer cancel()
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "finalize:"+storage.FormatUUID(r.ID)); err != nil {
			return err
		}
		var accepted bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM jobs WHERE id=$1)`, r.ID).Scan(&accepted); err != nil {
			return err
		}
		if accepted {
			return nil
		}
		var key string
		err := tx.QueryRow(ctx, `SELECT spool_key FROM upload_reservations WHERE id=$1 FOR UPDATE`, r.ID).Scan(&key)
		if errors.Is(err, pgx.ErrNoRows) {
			if err := s.storage.Delete(r.SpoolKey); err != nil {
				return err
			}
			return s.storage.RemoveJob(r.ID)
		}
		if err != nil {
			return err
		}
		if err := s.storage.Delete(key); err != nil {
			return err
		}
		// Also handles a promotion whose transaction outcome was unknown to the
		// caller. No accepted job exists under the same per-job lock.
		if err := s.storage.RemoveJob(r.ID); err != nil {
			return err
		}
		amount, ok, err := takeReservation(ctx, tx, r.ID)
		if err != nil || !ok {
			return err
		}
		return releaseBytes(ctx, tx, amount)
	})
	if err != nil {
		return fmt.Errorf("jobs: Reservierung freigeben: %w", err)
	}
	return nil
}

// Upload beschreibt eine vollständig empfangene, geprüfte Eingabe.
type Upload struct {
	Tool string
	// Options: bereits validierte Optionen in Python-kanonischer Form mit
	// Standardwerten (siehe CanonicalJSON); wird so gespeichert und gehasht.
	Options      json.RawMessage
	OriginalName string
	Size         int64
	SHA256       [32]byte
	InputFormat  string
	// OutputFormat: Bild- und Audiowerkzeuge, tatsächliches Zielformat
	// ("original" bereits aufgelöst). PDFLevels: pdf-compress, Reihenfolge = ordinal.
	OutputFormat string
	PDFLevels    []string
}

func (u Upload) resultRows(originalName string) ([]resultRow, error) {
	if u.Tool == "image-pdf" {
		return []resultRow{{ordinal: 0, mime: PDFMIME, name: ImagePdfDownloadName(originalName)}}, nil
	}
	if u.Tool == "markdown-pdf" {
		return []resultRow{{ordinal: 0, mime: PDFMIME, name: CleanBase(originalName, PDFFallbackBase) + ".pdf"}}, nil
	}
	if u.Tool == "pdf-compress" {
		if len(u.PDFLevels) == 0 {
			return nil, errors.New("jobs: PDF ohne Stufen")
		}
		rows := make([]resultRow, 0, len(u.PDFLevels))
		for i, level := range u.PDFLevels {
			rows = append(rows, resultRow{ordinal: int16(i), level: &level, mime: PDFMIME,
				name: PDFDownloadName(originalName, level)})
		}
		return rows, nil
	}
	if u.Tool == "audio-convert" {
		mime, ok := AudioMIME[u.OutputFormat]
		if !ok {
			return nil, errors.New("jobs: Audio-Zielformat nicht erzeugbar")
		}
		return []resultRow{{ordinal: 0, mime: mime,
			name: AudioDownloadName(originalName, u.InputFormat, u.OutputFormat)}}, nil
	}
	mime, ok := OutputMIME[u.OutputFormat]
	if !ok {
		return nil, errors.New("jobs: Zielformat nicht erzeugbar")
	}
	return []resultRow{{ordinal: 0, mime: mime,
		name: ImageDownloadName(originalName, u.Tool, u.InputFormat, u.OutputFormat)}}, nil
}

type resultRow struct {
	ordinal int16
	level   *string
	mime    string
	name    string
}

// Acceptance ist das Ergebnis von Finalize/ResolveReplay.
type Acceptance struct {
	Job      store.LoadedJob
	Replayed bool // true → 200 + Idempotent-Replayed, sonst 202
}

// Finalize nimmt den Auftrag in EINER Transaktion an
// (acceptance.accept_job): Reservierung auflösen und auf die tatsächliche
// Größe kürzen, Auftrag (queued), Ergebniszeilen (pending) und
// Outbox-Eintrag (dispatch) anlegen, Spooldatei an jobs/<id>/input
// verschieben, committen. Bei sicher zurückgerollter Annahme werden Datei
// und Reservierung entfernt; ein unklarer Commit wird zuerst unter derselben
// Transaktionssperre aufgelöst. Ohne Datenbank bleiben Datei/Reserve erhalten.
// Verliert der Insert gegen eine
// gleichzeitige Anfrage mit demselben Idempotenzschlüssel, folgt
// ResolveReplay. idempotencyKey "" = ohne Schlüssel.
//
// Fehler: ErrReservationGone, ErrIdempotencyConflict, store.ErrJobNotFound,
// store.ErrJobExpired, sonst technische Fehler.
func (s *Service) Finalize(ctx context.Context, sessionID [16]byte, r Reservation, u Upload, idempotencyKey string) (Acceptance, error) {
	// The reservation ID also identifies its prospective job. This lets
	// restart cleanup find an input promoted during an uncertain commit.
	jobID := r.ID
	targetKey := storage.InputKey(jobID)
	fallback := ImageFallbackBase
	switch {
	case u.InputFormat == "pdf" || u.InputFormat == "markdown":
		fallback = PDFFallbackBase
	case u.Tool == "audio-convert":
		fallback = AudioFallbackBase
	case u.Tool == "image-pdf":
		fallback = ImagePdfFallbackBase
	}
	rows, err := u.resultRows(u.OriginalName)
	if err == nil && u.Size > r.Bytes {
		err = errors.New("jobs: Datei größer als Reservierung")
	}
	var fingerprint []byte
	if err == nil && idempotencyKey != "" {
		var fp [32]byte
		fp, err = Fingerprint(u.Tool, u.Options, u.SHA256, u.Size)
		fingerprint = fp[:]
	}
	if err != nil {
		s.cleanupFailed(ctx, r, "")
		return Acceptance{}, err
	}
	var key *string
	if idempotencyKey != "" {
		key = &idempotencyKey
	}

	moved := ""
	err = s.finalizeTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "finalize:"+storage.FormatUUID(jobID)); err != nil {
			return err
		}
		reserved, ok, err := takeReservation(ctx, tx, r.ID)
		if err != nil {
			return err
		}
		if !ok {
			return ErrReservationGone
		}
		// Reservierung auf die tatsächliche Größe kürzen (Vertrag §7).
		if err := releaseBytes(ctx, tx, reserved-u.Size); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO jobs (id, session_id, tool, state, options, input_name,
       input_size, input_format, input_sha256, input_storage_key, idempotency_key, fingerprint,
       max_attempts, expires_at, reserved_bytes)
VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7, $8, $9, $10, $11, $12,
        now() + $13 * interval '1 microsecond', $6)`,
			jobID, sessionID, u.Tool, string(u.Options), DisplayName(u.OriginalName, fallback),
			u.Size, u.InputFormat, u.SHA256[:], targetKey, key, fingerprint,
			s.limits.JobMaxAttempts, s.limits.JobTTL.Microseconds()); err != nil {
			return err
		}
		for _, row := range rows {
			if _, err := tx.Exec(ctx, `INSERT INTO job_results (id, job_id, ordinal, level, mime, download_name)
VALUES ($1, $2, $3, $4, $5, $6)`, store.NewID(), jobID, row.ordinal, row.level, row.mime, row.name); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `INSERT INTO outbox (kind, job_id) VALUES ('dispatch', $1)`, jobID); err != nil {
			return err
		}
		// Datei erst verschieben, wenn alle Zeilen geschrieben sind; der
		// Commit folgt direkt danach.
		// Rename may succeed and its directory fsync may fail. Track the
		// target before Promote so the rollback also removes that case.
		moved = targetKey
		if err := s.storage.Promote(r.SpoolKey, targetKey); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		// A Commit error may mean that the commit succeeded and only its reply
		// was lost. Wait for the same per-job transaction lock before looking:
		// a plain SELECT could otherwise race the old uncommitted transaction.
		resolved, found, resolveErr := s.resolveAcceptance(ctx, jobID, sessionID)
		if resolveErr != nil {
			return Acceptance{}, fmt.Errorf("jobs: Annahmeausgang unklar: %w", err)
		}
		if found {
			return Acceptance{Job: resolved}, nil
		}
		s.cleanupFailed(ctx, r, moved)
		var pgErr *pgconn.PgError
		if idempotencyKey != "" && errors.As(err, &pgErr) &&
			pgErr.Code == "23505" && pgErr.ConstraintName == IdempotencyConstraint {
			// Gleichzeitige Wiederholung hat den Insert gewonnen (Vertrag §4).
			var fp [32]byte
			copy(fp[:], fingerprint)
			return s.ResolveReplay(ctx, sessionID, idempotencyKey, fp)
		}
		if errors.Is(err, ErrReservationGone) {
			return Acceptance{}, ErrReservationGone
		}
		return Acceptance{}, fmt.Errorf("jobs: Annahme: %w", err)
	}
	// Ab hier ist der Auftrag committet; Lesefehler dürfen die Datei nicht
	// mehr entfernen.
	loaded, err := store.LoadJob(ctx, s.pool, jobID, sessionID)
	if err != nil {
		return Acceptance{}, fmt.Errorf("jobs: angenommenen Auftrag lesen: %w", err)
	}
	return Acceptance{Job: loaded}, nil
}

func (s *Service) resolveAcceptance(ctx context.Context, jobID, sessionID [16]byte) (loaded store.LoadedJob, found bool, err error) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), cleanupTimeout)
	defer cancel()
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "finalize:"+storage.FormatUUID(jobID)); err != nil {
			return err
		}
		var err error
		loaded, err = store.LoadJob(ctx, tx, jobID, sessionID)
		if errors.Is(err, store.ErrJobNotFound) {
			return nil
		}
		found = err == nil
		return err
	})
	return
}

// cleanupFailed entfernt eine bereits verschobene Datei, die Spooldatei und
// die Reservierung (acceptance._cleanup). Fehler hier hinterlassen höchstens
// Reste, die der Cleanup über die abgelaufene Reservierung findet.
func (s *Service) cleanupFailed(ctx context.Context, r Reservation, moved string) {
	if moved != "" {
		if err := s.storage.Delete(moved); err != nil {
			// Persist the remaining internal key on the still-existing upload
			// reservation, so Cleanup can delete it before releasing its bytes.
			cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), cleanupTimeout)
			defer cancel()
			_, _ = s.pool.Exec(cleanupCtx, `UPDATE upload_reservations SET spool_key=$2 WHERE id=$1`, r.ID, moved)
			return
		}
	}
	_ = s.Release(ctx, r)
}

// replayTarget liest den Auftrag zu (Sitzung, Schlüssel); gelöscht →
// store.ErrJobNotFound, abgelaufen → store.ErrJobExpired.
func replayTarget(ctx context.Context, db store.DB, sessionID [16]byte, key string) (id [16]byte, fp []byte, found bool, err error) {
	var deleted, expired bool
	err = db.QueryRow(ctx, `SELECT id, fingerprint, deleted_at IS NOT NULL,
       state = 'expired' OR expires_at <= now()
  FROM jobs WHERE session_id = $1 AND idempotency_key = $2`, sessionID, key).Scan(&id, &fp, &deleted, &expired)
	if errors.Is(err, pgx.ErrNoRows) {
		return id, nil, false, nil
	}
	if err != nil {
		return id, nil, false, fmt.Errorf("jobs: Idempotenzschlüssel: %w", err)
	}
	if deleted {
		return id, nil, true, store.ErrJobNotFound
	}
	if expired {
		return id, nil, true, store.ErrJobExpired
	}
	return id, fp, true, nil
}

// LookupReplay prüft vor dem Lesen des Bodys, ob (Sitzung, Schlüssel)
// bereits einen Auftrag hat (Vertrag §4 Schritt 2): false = neuer Auftrag;
// true = Wiederholung; gelöscht → store.ErrJobNotFound, abgelaufen →
// store.ErrJobExpired – jeweils ohne Body zu lesen.
func (s *Service) LookupReplay(ctx context.Context, sessionID [16]byte, idempotencyKey string) (bool, error) {
	_, _, found, err := replayTarget(ctx, s.pool, sessionID, idempotencyKey)
	return found, err
}

// ResolveReplay vergleicht eine Wiederholung mit dem vorhandenen Auftrag
// (acceptance.resolve_replay): gleicher Fingerabdruck → Acceptance mit
// Replayed; anderer → ErrIdempotencyConflict; fehlt/gelöscht →
// store.ErrJobNotFound; abgelaufen → store.ErrJobExpired.
func (s *Service) ResolveReplay(ctx context.Context, sessionID [16]byte, idempotencyKey string, fingerprint [32]byte) (Acceptance, error) {
	var acc Acceptance
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		id, fp, found, err := replayTarget(ctx, tx, sessionID, idempotencyKey)
		if err != nil {
			return err
		}
		if !found {
			return store.ErrJobNotFound
		}
		if string(fp) != string(fingerprint[:]) {
			return ErrIdempotencyConflict
		}
		acc.Job, err = store.LoadJob(ctx, tx, id, sessionID)
		acc.Replayed = true
		return err
	})
	if err != nil {
		return Acceptance{}, err
	}
	return acc, nil
}
