package jobs

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"miconverter/server/internal/storage"
)

// CleanupConfig must match the worker's parser deadlines. Bytes from retired
// attempts remain reserved until no parser can still be writing their files.
type CleanupConfig struct {
	Runtime   RuntimeConfig
	UploadMax time.Duration
}

type CleanupCounts struct{ Jobs, Uploads, StaleAttempts, Orphans, Sessions int }

type Cleaner struct {
	pool    *pgxpool.Pool
	storage *storage.Local
	cfg     CleanupConfig
}

func NewCleaner(pool *pgxpool.Pool, st *storage.Local, cfg CleanupConfig) *Cleaner {
	cfg.Runtime = cfg.Runtime.withDefaults()
	if cfg.UploadMax <= 0 {
		cfg.UploadMax = 600 * time.Second
	}
	return &Cleaner{pool: pool, storage: st, cfg: cfg}
}

// Once is repeatable after crashes. Files are removed before reservations are
// released. A failed commit therefore causes safe repeated deletion, never
// double accounting or a file whose bytes have become unreserved.
func (c *Cleaner) Once(ctx context.Context) (counts CleanupCounts, err error) {
	err = pgx.BeginFunc(ctx, c.pool, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT job_id, lease_token FROM stale_attempts WHERE reap_after <= now()`)
		if err != nil {
			return err
		}
		type attempt struct{ job, token [16]byte }
		list, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (attempt, error) {
			var a attempt
			err := row.Scan(&a.job, &a.token)
			return a, err
		})
		if err != nil {
			return err
		}
		for _, a := range list {
			var owner [16]byte
			if err := tx.QueryRow(ctx, `SELECT id FROM jobs WHERE id=$1 FOR UPDATE SKIP LOCKED`, a.job).Scan(&owner); errors.Is(err, pgx.ErrNoRows) {
				continue
			} else if err != nil {
				return err
			}
			var amount int64
			if err := tx.QueryRow(ctx, `SELECT reserved_bytes FROM stale_attempts WHERE lease_token=$1 AND reap_after <= now() FOR UPDATE`, a.token).Scan(&amount); errors.Is(err, pgx.ErrNoRows) {
				continue
			} else if err != nil {
				return err
			}
			keys, err := publishedKeys(ctx, tx, a.job)
			if err != nil {
				return err
			}
			jobPath, err := c.storage.Path(storage.JobKey(a.job))
			if err != nil {
				return err
			}
			files, err := filepath.Glob(filepath.Join(jobPath, "results", "*", storage.FormatUUID(a.token)))
			if err != nil {
				return err
			}
			for _, file := range files {
				key, err := c.key(file)
				if err != nil {
					return err
				}
				if !keys[key] {
					if err := c.storage.Delete(key); err != nil {
						return err
					}
				}
			}
			if err := releaseBytes(ctx, tx, amount); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `DELETE FROM stale_attempts WHERE lease_token=$1`, a.token); err != nil {
				return err
			}
			counts.StaleAttempts++
		}
		rows, err = tx.Query(ctx, `SELECT id FROM jobs WHERE expires_at<=now() OR deleted_at IS NOT NULL FOR UPDATE SKIP LOCKED`)
		if err != nil {
			return err
		}
		ids, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) ([16]byte, error) { var id [16]byte; err := r.Scan(&id); return id, err })
		if err != nil {
			return err
		}
		for _, id := range ids {
			var state string
			var lease *[16]byte
			var working, reserved int64
			var expired, download bool
			if err := tx.QueryRow(ctx, `SELECT state,lease_token,working_bytes,reserved_bytes,expires_at<=now(),coalesce(download_until>now(),false) FROM jobs WHERE id=$1`, id).Scan(&state, &lease, &working, &reserved, &expired, &download); err != nil {
				return err
			}
			if state == "running" && lease != nil {
				if _, err := tx.Exec(ctx, `INSERT INTO stale_attempts(lease_token,job_id,reserved_bytes,reap_after) VALUES($1,$2,$3,now()+$4*interval '1 microsecond')`, *lease, id, working, c.cfg.Runtime.staleGrace().Microseconds()); err != nil {
					return err
				}
				state = "cancelled"
				if expired {
					state = "expired"
				}
				if _, err := tx.Exec(ctx, `UPDATE jobs SET state=$2,phase=NULL,progress=NULL,lease_token=NULL,lease_expires_at=NULL,working_bytes=0,version=version+1,updated_at=now() WHERE id=$1`, id, state); err != nil {
					return err
				}
				working = 0
			} else if expired && state != "expired" {
				if _, err := tx.Exec(ctx, `UPDATE jobs SET state='expired',phase=NULL,progress=NULL,version=version+1,updated_at=now() WHERE id=$1`, id); err != nil {
					return err
				}
			}
			var stale bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM stale_attempts WHERE job_id=$1)`, id).Scan(&stale); err != nil {
				return err
			}
			if download || stale {
				continue
			}
			if err := c.storage.RemoveJob(id); err != nil {
				return err
			}
			if err := releaseBytes(ctx, tx, reserved+working); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `DELETE FROM jobs WHERE id=$1`, id); err != nil {
				return err
			}
			counts.Jobs++
		}
		rows, err = tx.Query(ctx, `SELECT id,spool_key,bytes FROM upload_reservations WHERE expires_at < now()-interval '10 seconds' FOR UPDATE SKIP LOCKED`)
		if err != nil {
			return err
		}
		type reservation struct {
			id    [16]byte
			key   string
			bytes int64
		}
		uploads, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (reservation, error) {
			var v reservation
			err := r.Scan(&v.id, &v.key, &v.bytes)
			return v, err
		})
		if err != nil {
			return err
		}
		for _, v := range uploads {
			if err := c.storage.Delete(v.key); err != nil {
				return err
			}
			// Go reserves prospective JobID == ReservationID. An interrupted
			// promotion/uncertain commit may have moved input out of spool.
			var exists bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM jobs WHERE id=$1)`, v.id).Scan(&exists); err != nil {
				return err
			}
			if !exists {
				if err := c.storage.RemoveJob(v.id); err != nil {
					return err
				}
			}
			if err := releaseBytes(ctx, tx, v.bytes); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `DELETE FROM upload_reservations WHERE id=$1`, v.id); err != nil {
				return err
			}
			counts.Uploads++
		}
		tag, err := tx.Exec(ctx, `DELETE FROM sessions s WHERE expires_at<now() AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.session_id=s.id) AND NOT EXISTS(SELECT 1 FROM upload_reservations u WHERE u.session_id=s.id)`)
		if err != nil {
			return err
		}
		counts.Sessions = int(tag.RowsAffected())
		return nil
	})
	if err != nil {
		return counts, fmt.Errorf("jobs: Cleanup: %w", err)
	}
	orphans, err := c.orphans(ctx)
	counts.Orphans = orphans
	return counts, err
}

func publishedKeys(ctx context.Context, tx pgx.Tx, id [16]byte) (map[string]bool, error) {
	rows, err := tx.Query(ctx, `SELECT storage_key FROM job_results WHERE job_id=$1 AND storage_key IS NOT NULL`, id)
	if err != nil {
		return nil, err
	}
	keys, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	result := map[string]bool{}
	for _, key := range keys {
		result[key] = true
	}
	return result, nil
}

func (c *Cleaner) key(path string) (string, error) {
	rel, err := filepath.Rel(c.storage.Root(), path)
	if err != nil {
		return "", err
	}
	key := filepath.ToSlash(rel)
	if err := storage.ValidateKey(key); err != nil {
		return "", err
	}
	return key, nil
}

func (c *Cleaner) orphans(ctx context.Context) (count int, err error) {
	err = pgx.BeginFunc(ctx, c.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, AdmissionLockKey); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `SELECT spool_key FROM upload_reservations`)
		if err != nil {
			return err
		}
		spools, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return err
		}
		liveSpool := map[string]bool{}
		for _, v := range spools {
			liveSpool[v] = true
		}
		cutoff := time.Now().Add(-max(c.cfg.UploadMax+60*time.Second, 600*time.Second))
		entries, err := os.ReadDir(filepath.Join(c.storage.Root(), "spool"))
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		for _, entry := range entries {
			key := "spool/" + entry.Name()
			if storage.ValidateKey(key) != nil {
				continue
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			if !liveSpool[key] && info.ModTime().Before(cutoff) {
				if err := c.storage.Delete(key); err != nil {
					return err
				}
				count++
			}
		}
		entries, err = os.ReadDir(filepath.Join(c.storage.Root(), "jobs"))
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		for _, entry := range entries {
			key := "jobs/" + entry.Name()
			if storage.ValidateKey(key) != nil {
				continue
			}
			var id [16]byte
			var lease *[16]byte
			var recent bool
			err := tx.QueryRow(ctx, `SELECT id,lease_token,updated_at>now()-interval '10 seconds' FROM jobs WHERE id::text=$1 FOR UPDATE SKIP LOCKED`, entry.Name()).Scan(&id, &lease, &recent)
			if errors.Is(err, pgx.ErrNoRows) {
				// SKIP LOCKED does not mean absent: never delete a locked live job.
				var exists bool
				if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM jobs WHERE id::text=$1)`, entry.Name()).Scan(&exists); err != nil {
					return err
				}
				if exists {
					continue
				}
				info, err := entry.Info()
				if err != nil {
					return err
				}
				if !info.ModTime().Before(cutoff) {
					continue
				}
				decoded, err := hex.DecodeString(strings.ReplaceAll(entry.Name(), "-", ""))
				if err != nil {
					return err
				}
				var parsed [16]byte
				copy(parsed[:], decoded)
				if err := c.storage.RemoveJob(parsed); err != nil {
					return err
				}
				count++
				continue
			}
			if err != nil {
				return err
			}
			if recent {
				continue
			}
			valid, err := publishedKeys(ctx, tx, id)
			if err != nil {
				return err
			}
			rows, err := tx.Query(ctx, `SELECT lease_token::text FROM stale_attempts WHERE job_id=$1`, id)
			if err != nil {
				return err
			}
			tokens, err := pgx.CollectRows(rows, pgx.RowTo[string])
			if err != nil {
				return err
			}
			protected := map[string]bool{}
			for _, token := range tokens {
				protected[token] = true
			}
			if lease != nil {
				protected[storage.FormatUUID(*lease)] = true
			}
			files, err := filepath.Glob(filepath.Join(c.storage.Root(), key, "results", "*", "*"))
			if err != nil {
				return err
			}
			for _, file := range files {
				resultKey, err := c.key(file)
				if err != nil {
					return err
				}
				info, err := os.Lstat(file)
				if err != nil {
					return err
				}
				if !valid[resultKey] && !protected[filepath.Base(file)] && info.ModTime().Before(time.Now().Add(-10*time.Second)) {
					if err := c.storage.Delete(resultKey); err != nil {
						return err
					}
					count++
				}
			}
		}
		return nil
	})
	return count, err
}
