"""Aufträge lesen, als Antwort darstellen und logisch löschen.

Jede Abfrage ist an die Sitzung gebunden: Eine Auftrags-UUID allein ist
keine Berechtigung (Vertrag §3). Fremde, unbekannte und gelöschte Aufträge
sind von außen nicht unterscheidbar.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import case, func, insert, select, update
from sqlalchemy.orm import Session

from app.api import API_PREFIX
from app.api.errors import ApiErrorCode, ProcessingErrorCode
from app.db.models import Job, JobResult, OutboxEntry
from app.jobs.domain import (
    ACTIVE_JOB_STATES,
    InputFormat,
    JobPhase,
    JobState,
    OutboxKind,
    PdfLevel,
    ResultState,
    Tool,
)
from app.schemas.jobs import JobError, JobInput, JobResultView, JobView


@dataclass(frozen=True)
class LoadedJob:
    job: Job
    results: list[JobResult]


def load_job(db: Session, job_id: uuid.UUID, session_id: uuid.UUID) -> LoadedJob | None:
    job = db.execute(
        select(Job).where(Job.id == job_id, Job.session_id == session_id, Job.deleted_at.is_(None))
    ).scalar_one_or_none()
    if job is None:
        return None
    results = list(
        db.execute(
            select(JobResult).where(JobResult.job_id == job.id).order_by(JobResult.ordinal)
        ).scalars()
    )
    return LoadedJob(job=job, results=results)


def is_expired(job: Job, now: datetime) -> bool:
    return job.state == JobState.EXPIRED or job.expires_at <= now


def _error(code: str | None) -> JobError | None:
    if code is None:
        return None
    try:
        return JobError(code=ProcessingErrorCode(code))
    except ValueError:
        return JobError(code=ApiErrorCode(code))


def to_view(loaded: LoadedJob, now: datetime | None = None) -> JobView:
    """Datenbankzeilen → Antwort. Abgelaufene Aufträge zeigen ``expired`` und
    keine Download-URLs, auch wenn der Cleanup sie noch nicht umgestellt hat."""
    now = now or datetime.now(UTC)
    job = loaded.job
    expired = is_expired(job, now)
    state = JobState.EXPIRED if expired else JobState(job.state)
    results = [
        JobResultView(
            id=result.id,
            level=PdfLevel(result.level) if result.level else None,
            state=ResultState(result.state),
            size=result.size,
            mime=result.mime,
            download_name=result.download_name,
            download_url=(
                f"{API_PREFIX}/jobs/{job.id}/results/{result.id}"
                if result.state == ResultState.SUCCEEDED and not expired
                else None
            ),
            details=result.details,
            error=_error(result.error_code),
        )
        for result in loaded.results
    ]
    return JobView(
        id=job.id,
        tool=Tool(job.tool),
        state=state,
        phase=JobPhase(job.phase) if job.phase and state == JobState.RUNNING else None,
        created_at=job.created_at,
        updated_at=job.updated_at,
        expires_at=job.expires_at,
        input=JobInput(
            name=job.input_name,
            size=job.input_size,
            format=InputFormat(job.input_format),
            width=job.input_width,
            height=job.input_height,
        ),
        progress=job.progress if state == JobState.RUNNING else None,
        analysis=job.analysis,
        results=results,
        error=_error(job.error_code),
        cancel_requested=job.cancel_requested_at is not None,
    )


def mark_deleted(db: Session, job_id: uuid.UUID, session_id: uuid.UUID) -> bool:
    """Sperrt den Auftrag sofort und plant die physische Löschung (Outbox).

    Laufende/wartende Aufträge erhalten zusätzlich einen Abbruchwunsch; der
    Worker (B04) darf danach nichts mehr veröffentlichen, weil alle seine
    Schreibzugriffe ``deleted_at IS NULL`` verlangen.
    """
    active = [state.value for state in ACTIVE_JOB_STATES]
    deleted = db.execute(
        update(Job)
        .where(Job.id == job_id, Job.session_id == session_id, Job.deleted_at.is_(None))
        .values(
            deleted_at=func.now(),
            cancel_requested_at=case(
                (Job.state.in_(active), func.coalesce(Job.cancel_requested_at, func.now())),
                else_=Job.cancel_requested_at,
            ),
            version=Job.version + 1,
            updated_at=func.now(),
        )
        .returning(Job.id)
    ).scalar_one_or_none()
    if deleted is None:
        return False
    db.execute(insert(OutboxEntry).values(kind=OutboxKind.DELETE.value, job_id=job_id))
    return True
