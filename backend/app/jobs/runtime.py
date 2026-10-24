"""Atomare Worker-Übergänge. PostgreSQL entscheidet, niemals der Broker."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.db.engine import Database
from app.db.models import Job, JobResult, OutboxEntry, StaleAttempt
from app.jobs.admission import release_bytes, reserve_bytes
from app.jobs.domain import OutboxKind

LEASE_SECONDS = 30


@dataclass(frozen=True)
class Claim:
    id: uuid.UUID
    token: uuid.UUID
    tool: str
    options: dict[str, Any]
    input_key: str
    results: list[tuple[uuid.UUID, str | None]]


def owned(job_id: uuid.UUID, token: uuid.UUID) -> Any:
    return (
        (Job.id == job_id)
        & (Job.state == "running")
        & (Job.lease_token == token)
        & (Job.lease_expires_at > func.now())
        & (Job.deleted_at.is_(None))
        & (Job.expires_at > func.now())
    )


def claim(database: Database, job_id: uuid.UUID, settings: Settings) -> Claim | None:
    token = uuid.uuid4()
    with database.session() as db, db.begin():
        job = db.execute(select(Job).where(Job.id == job_id).with_for_update()).scalar_one_or_none()
        if job is None:
            return None
        now = db.execute(select(func.now())).scalar_one()
        if (
            job.state != "queued"
            or job.deleted_at is not None
            or job.cancel_requested_at is not None
            or job.expires_at <= now
            or job.attempts >= job.max_attempts
        ):
            return None
        working = (
            max(0, settings.pdf_max_results_total_bytes - (job.reserved_bytes - job.input_size))
            if job.tool == "pdf-compress"
            else settings.image_max_output_bytes
        )
        if not reserve_bytes(db, working, settings.storage_budget_bytes):
            job.state, job.error_code = "failed", "storage-full"
            job.finished_at = now
            return None
        job.state, job.phase = "running", "analyze"
        job.lease_token, job.working_bytes = token, working
        job.lease_expires_at = now + timedelta(seconds=LEASE_SECONDS)
        job.heartbeat_at, job.started_at, job.updated_at = now, now, now
        job.attempts += 1
        job.version += 1
        results = list(
            db.scalars(
                select(JobResult).where(JobResult.job_id == job.id).order_by(JobResult.ordinal)
            )
        )
        pending = []
        for result in results:
            if result.state != "succeeded":
                result.state, result.error_code = "pending", None
                pending.append((result.id, result.level))
        return Claim(job.id, token, job.tool, job.options, job.input_storage_key, pending)


def heartbeat(database: Database, task: Claim) -> bool:
    with database.session() as db, db.begin():
        return (
            db.execute(
                update(Job)
                .where(owned(task.id, task.token), Job.cancel_requested_at.is_(None))
                .values(
                    heartbeat_at=func.now(),
                    lease_expires_at=func.now() + timedelta(seconds=LEASE_SECONDS),
                )
                .returning(Job.id)
            ).scalar_one_or_none()
            is not None
        )


def event(database: Database, task: Claim, payload: dict[str, Any]) -> bool:
    with database.session() as db, db.begin():
        job = db.scalar(
            select(Job)
            .where(owned(task.id, task.token), Job.cancel_requested_at.is_(None))
            .with_for_update()
        )
        if job is None:
            return False
        job.updated_at = db.execute(select(func.now())).scalar_one()
        kind = payload["kind"]
        if kind == "analysis":
            job.analysis = payload["analysis"]
        elif kind == "progress":
            job.phase, job.progress = payload.get("phase", "variant"), payload.get("progress")
        elif kind in {"result", "error"}:
            result = db.scalar(
                select(JobResult)
                .where(JobResult.id == uuid.UUID(payload["id"]), JobResult.job_id == task.id)
                .with_for_update()
            )
            if result is None or result.state == "succeeded":
                return False
            if kind == "error":
                result.state, result.error_code = "failed", payload["code"]
            else:
                size = int(payload["size"])
                if size < 0 or size > job.working_bytes:
                    result.state, result.error_code = "failed", "result-too-large"
                    return False
                result.storage_key, result.size = payload["key"], size
                result.details, result.state = payload["details"], "succeeded"
                job.working_bytes -= size
                job.reserved_bytes += size
                details = payload["details"]
                if task.tool != "pdf-compress":
                    job.input_width = details.get("sourceWidth")
                    job.input_height = details.get("sourceHeight")
        return True


def finish(database: Database, task: Claim, error: str | None = None) -> None:
    with database.session() as db, db.begin():
        job = db.scalar(
            select(Job)
            .where(
                Job.id == task.id,
                Job.state == "running",
                Job.lease_token == task.token,
                Job.lease_expires_at > func.now(),
                Job.deleted_at.is_(None),
            )
            .with_for_update()
        )
        if job is None:
            return
        results = list(db.scalars(select(JobResult).where(JobResult.job_id == task.id)))
        now = db.execute(select(func.now())).scalar_one()
        cancelled = job.cancel_requested_at is not None or job.deleted_at is not None
        expired = job.expires_at <= now
        for result in results:
            if result.state not in {"succeeded", "failed", "cancelled"}:
                result.state = "cancelled" if cancelled or expired else "failed"
                result.error_code = None if cancelled or expired else (error or "worker-failed")
        successful = sum(result.state == "succeeded" for result in results)
        job.state = (
            "expired"
            if expired
            else "cancelled"
            if cancelled
            else "succeeded"
            if successful == len(results)
            else "partially_succeeded"
            if successful
            else "failed"
        )
        job.error_code = (
            (error or next((r.error_code for r in results if r.error_code), "worker-failed"))
            if job.state == "failed"
            else None
        )
        job.phase, job.progress = None, None
        job.finished_at, job.updated_at = now, now
        job.lease_token, job.lease_expires_at = None, None
        job.version += 1
        release_bytes(db, job.working_bytes)
        job.working_bytes = 0


def cancel(db: Session, job: Job) -> str:
    if job.state == "cancelled":
        return "completed"
    if (
        job.state not in {"queued", "running"}
        or job.expires_at <= db.execute(select(func.now())).scalar_one()
    ):
        return "not-applicable"
    job.cancel_requested_at = func.now()
    job.version += 1
    if job.state == "queued":
        job.state, job.phase, job.finished_at = "cancelled", None, func.now()
        db.execute(
            update(JobResult)
            .where(JobResult.job_id == job.id, JobResult.state.in_(["pending", "running"]))
            .values(state="cancelled")
        )
        return "completed"
    return "requested"


def retire_attempt(db: Session, job: Job, now: datetime, settings: Settings | None) -> None:
    """Transfer the still-existing disk reservation to a timed stale lease."""
    if job.lease_token is not None:
        maximum = (
            max(settings.image_timeout_seconds, settings.pdf_timeout_seconds) if settings else 300
        )
        db.add(
            StaleAttempt(
                job_id=job.id,
                lease_token=job.lease_token,
                reserved_bytes=job.working_bytes,
                reap_after=now + timedelta(seconds=maximum + 10),
            )
        )
    job.working_bytes = 0
    job.lease_token, job.lease_expires_at = None, None


def recover(database: Database, settings: Settings | None = None) -> int:
    count = 0
    with database.session() as db, db.begin():
        jobs = list(
            db.scalars(
                select(Job)
                .where(Job.state == "running", Job.lease_expires_at <= func.now())
                .with_for_update(skip_locked=True)
            )
        )
        for job in jobs:
            now = db.execute(select(func.now())).scalar_one()
            has_result = (
                db.scalar(
                    select(JobResult.id)
                    .where(JobResult.job_id == job.id, JobResult.state == "succeeded")
                    .limit(1)
                )
                is not None
            )
            retire_attempt(db, job, now, settings)
            job.lease_token, job.lease_expires_at, job.phase, job.progress = None, None, None, None
            if job.expires_at <= now:
                job.state = "expired"
            elif job.cancel_requested_at is not None or job.deleted_at is not None:
                job.state = "cancelled"
            elif job.attempts >= job.max_attempts:
                job.state = "partially_succeeded" if has_result else "failed"
                job.error_code = None if has_result else "worker-failed"
            else:
                job.state = "queued"
                db.add(OutboxEntry(kind=OutboxKind.DISPATCH.value, job_id=job.id))
            db.execute(
                update(JobResult)
                .where(JobResult.job_id == job.id, JobResult.state.in_(["pending", "running"]))
                .values(
                    state="pending"
                    if job.state == "queued"
                    else "cancelled"
                    if job.state == "cancelled"
                    else "failed",
                    error_code="worker-failed"
                    if job.state in {"failed", "partially_succeeded"}
                    else None,
                )
            )
            job.version += 1
            job.updated_at = now
            if job.state != "queued":
                job.finished_at = now
            count += 1
    return count
