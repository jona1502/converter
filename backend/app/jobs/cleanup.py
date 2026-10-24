"""Restart-safe expiry, private file cleanup and storage reservation release."""

from __future__ import annotations

import logging
import shutil
import time
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, exists, func, or_, select

from app.core.config import Settings
from app.db.engine import Database
from app.db.models import AnonymousSession, Job, JobResult, StaleAttempt, UploadReservation
from app.jobs.admission import release_bytes
from app.jobs.domain import JobState
from app.jobs.runtime import retire_attempt
from app.storage.local import LocalStorage, job_key

logger = logging.getLogger(__name__)


def _remove_tree(storage: LocalStorage, key: str) -> None:
    path = storage.path_for(key)
    root = storage.root.resolve()
    if path.resolve() == root or not path.resolve().is_relative_to(root):
        raise ValueError("Unsafe cleanup path")
    if path.is_symlink():
        path.unlink()
    elif path.exists():
        shutil.rmtree(path)


def cleanup_once(database: Database, storage: LocalStorage, settings: Settings) -> dict[str, int]:
    counts = {"jobs": 0, "uploads": 0, "orphans": 0, "sessions": 0, "staleAttempts": 0}
    now = datetime.now(UTC)
    grace = timedelta(seconds=10)
    with database.session() as db, db.begin():
        due = list(
            db.execute(
                select(StaleAttempt.job_id, StaleAttempt.lease_token).where(
                    StaleAttempt.reap_after <= now
                )
            )
        )
        for attempt_job_id, token in due:
            owner = db.scalar(
                select(Job).where(Job.id == attempt_job_id).with_for_update(skip_locked=True)
            )
            if owner is None:
                continue
            attempt = db.get(StaleAttempt, token, with_for_update=True)
            if attempt is None or attempt.reap_after > now:
                continue
            published_keys = set(
                db.execute(
                    select(JobResult.storage_key).where(
                        JobResult.job_id == attempt_job_id,
                        JobResult.state == "succeeded",
                        JobResult.storage_key.is_not(None),
                    )
                ).scalars()
            )
            for file in (storage.path_for(job_key(attempt_job_id)) / "results").glob(
                "*/" + str(token)
            ):
                key = file.relative_to(storage.root).as_posix()
                if key not in published_keys:
                    storage.delete(key)
            release_bytes(db, attempt.reserved_bytes)
            db.delete(attempt)
            counts["staleAttempts"] += 1
        db.flush()
        jobs = (
            db.execute(
                select(Job)
                .where(or_(Job.expires_at <= func.now(), Job.deleted_at.is_not(None)))
                .with_for_update(skip_locked=True)
            )
            .scalars()
            .all()
        )
        for job in jobs:
            if job.state == "running":
                retire_attempt(db, job, now, settings)
                job.state = "expired" if job.expires_at <= now else "cancelled"
                job.phase = None
                job.version += 1
                job.updated_at = now
                db.flush()
            if job.expires_at <= now and job.state != JobState.EXPIRED:
                job.state, job.phase = JobState.EXPIRED.value, None
                job.version += 1
                job.updated_at = now
            # A stale worker must observe the lost lease and stop before removal;
            # a download keeps a finite DB lease even after logical deletion.
            if job.download_until is not None and job.download_until > now:
                continue
            if job.lease_expires_at is not None and job.lease_expires_at + grace > now:
                continue
            if (
                db.scalar(
                    select(StaleAttempt.lease_token).where(StaleAttempt.job_id == job.id).limit(1)
                )
                is not None
            ):
                continue
            _remove_tree(storage, job_key(job.id))
            release_bytes(db, job.reserved_bytes + job.working_bytes)
            db.delete(job)
            counts["jobs"] += 1
        reservations = (
            db.execute(
                select(UploadReservation)
                .where(UploadReservation.expires_at < now - grace)
                .with_for_update(skip_locked=True)
            )
            .scalars()
            .all()
        )
        for reservation in reservations:
            storage.delete(reservation.spool_key)
            release_bytes(db, reservation.bytes)
            db.delete(reservation)
            counts["uploads"] += 1
        db.flush()
        # Expired sessions with live metadata are retained until their jobs clear.
        result = db.execute(
            delete(AnonymousSession)
            .where(
                AnonymousSession.expires_at < now,
                ~exists(select(Job.id).where(Job.session_id == AnonymousSession.id)),
                ~exists(
                    select(UploadReservation.id).where(
                        UploadReservation.session_id == AnonymousSession.id
                    )
                ),
            )
            .returning(AnonymousSession.id)
        )
        counts["sessions"] = len(list(result.scalars()))
    # Orphan cleanup uses an age grace, then rechecks the database under the
    # admission lock before deleting: uploads/claims cannot race acceptance.
    from app.jobs.admission import ADMISSION_LOCK_KEY

    with database.session() as db, db.begin():
        db.execute(select(func.pg_advisory_xact_lock(ADMISSION_LOCK_KEY)))
        jobs_by_id = {str(job.id): job for job in db.execute(select(Job)).scalars()}
        live_jobs = set(jobs_by_id)
        live_spools = set(db.execute(select(UploadReservation.spool_key)).scalars())
        cutoff = time.time() - max(settings.upload_max_seconds + 60, 600)
        for path in (storage.root / "spool").glob("*"):
            key = "spool/" + path.name
            if key not in live_spools and path.stat().st_mtime < cutoff:
                storage.delete(key)
                counts["orphans"] += 1
        for path in (storage.root / "jobs").glob("*"):
            if path.name not in live_jobs and path.stat().st_mtime < cutoff:
                _remove_tree(storage, "jobs/" + path.name)
                counts["orphans"] += 1
        stale_cutoff = time.time() - 10
        for job_id, job in jobs_by_id.items():
            # Runtime claim/publication also locks this row. A file belonging to
            # the current lease remains protected until its lease ends + grace.
            db.refresh(job, with_for_update=True)
            keep_lease = str(job.lease_token) if job.lease_token is not None else None
            if job.updated_at + grace > now:
                continue
            result_root = storage.path_for("jobs/" + job_id) / "results"
            # Recheck published keys after row lock: an in-flight publication
            # may have committed since the initial orphan snapshot.
            protected = {
                str(token)
                for token in db.execute(
                    select(StaleAttempt.lease_token).where(StaleAttempt.job_id == job.id)
                ).scalars()
            }
            valid = set(
                db.execute(
                    select(JobResult.storage_key).where(
                        JobResult.job_id == job.id, JobResult.storage_key.is_not(None)
                    )
                ).scalars()
            )
            for file in result_root.glob("*/*"):
                key = file.relative_to(storage.root).as_posix()
                if (
                    key not in valid
                    and file.name not in protected
                    and file.name != keep_lease
                    and file.stat().st_mtime < stale_cutoff
                ):
                    storage.delete(key)
                    counts["orphans"] += 1
    return counts


def run() -> None:
    from app.db.engine import normalize_database_url

    settings = Settings()
    if settings.database_url is None:
        raise RuntimeError("database_url required")
    database = Database(
        normalize_database_url(settings.database_url.get_secret_value()),
        pool_size=settings.database_pool_size,
    )
    storage = LocalStorage(settings.storage_dir)
    try:
        while True:
            try:
                cleanup_once(database, storage, settings)
            except Exception:
                logger.error("cleanup_failed")
            time.sleep(settings.cleanup_interval_seconds)
    finally:
        database.dispose()


if __name__ == "__main__":
    run()
