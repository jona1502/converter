"""Besitzergebundene Downloads und Abbruch."""

from __future__ import annotations

import time
import uuid
from collections.abc import Iterator
from datetime import timedelta
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from starlette.background import BackgroundTask

from app.api import API_PREFIX
from app.api.auth import CurrentSessionDep, WriteSessionDep
from app.api.deps import DatabaseDep, SettingsDep, StorageDep
from app.api.errors import ApiError, ApiErrorCode, ErrorResponse
from app.db.models import Job, JobResult
from app.jobs.queries import load_job, to_view
from app.jobs.runtime import cancel

router = APIRouter(prefix=f"{API_PREFIX}/jobs", tags=["jobs"])


def ids(value: str) -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except ValueError:
        raise ApiError(ApiErrorCode.JOB_NOT_FOUND, 404, "Auftrag nicht gefunden.") from None


@router.post(
    "/{job_id}/cancel",
    responses={
        401: {"model": ErrorResponse},
        403: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
        422: {"model": ErrorResponse},
    },
)
def cancel_job(job_id: str, session: WriteSessionDep, database: DatabaseDep) -> dict[str, Any]:
    with database.session() as db, db.begin():
        job = db.scalar(
            select(Job)
            .where(Job.id == ids(job_id), Job.session_id == session.id, Job.deleted_at.is_(None))
            .with_for_update()
        )
        if job is None:
            raise ApiError(ApiErrorCode.JOB_NOT_FOUND, 404, "Auftrag nicht gefunden.")
        cancellation = cancel(db, job)
    with database.session() as db:
        loaded = load_job(db, ids(job_id), session.id)
        if loaded is None:
            raise ApiError(ApiErrorCode.JOB_NOT_FOUND, 404, "Auftrag nicht gefunden.")
        return {"cancellation": cancellation, "job": to_view(loaded).model_dump(mode="json")}


@router.get(
    "/{job_id}/results/{result_id}",
    responses={
        401: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
        410: {"model": ErrorResponse},
        422: {"model": ErrorResponse},
    },
)
def download(
    job_id: str,
    result_id: str,
    session: CurrentSessionDep,
    database: DatabaseDep,
    storage: StorageDep,
    settings: SettingsDep,
) -> StreamingResponse:
    with database.session() as db, db.begin():
        job = db.scalar(
            select(Job)
            .where(Job.id == ids(job_id), Job.session_id == session.id, Job.deleted_at.is_(None))
            .with_for_update()
        )
        if job is None:
            raise ApiError(ApiErrorCode.JOB_NOT_FOUND, 404, "Auftrag nicht gefunden.")
        now = db.execute(select(func.now())).scalar_one()
        if job.expires_at <= now or job.state == "expired":
            raise ApiError(ApiErrorCode.JOB_EXPIRED, 410, "Auftrag abgelaufen.")
        result = db.scalar(
            select(JobResult).where(
                JobResult.id == ids(result_id),
                JobResult.job_id == job.id,
                JobResult.state == "succeeded",
            )
        )
        if result is None or result.storage_key is None or result.size is None:
            raise ApiError(ApiErrorCode.RESULT_NOT_FOUND, 404, "Ergebnis nicht gefunden.")
        path = storage.path_for(result.storage_key)
        job.download_until = now + timedelta(seconds=settings.download_max_seconds)
        size, mime, filename = result.size, result.mime, result.download_name
    try:
        stream = path.open("rb")
    except FileNotFoundError:
        raise ApiError(ApiErrorCode.RESULT_NOT_FOUND, 404, "Ergebnis nicht gefunden.") from None
    deadline = time.monotonic() + settings.download_max_seconds

    def chunks() -> Iterator[bytes]:
        with stream:
            while time.monotonic() < deadline:
                chunk = stream.read(64 * 1024)
                if not chunk:
                    return
                yield chunk

    ascii_name = "".join(
        char if 32 <= ord(char) < 127 and char not in {'"', "\\"} else "_" for char in filename
    )
    return StreamingResponse(
        chunks(),
        media_type=mime,
        background=BackgroundTask(stream.close),
        headers={
            "Content-Length": str(size),
            "Content-Disposition": (
                f"attachment; filename=\"{ascii_name}\"; "
                f"filename*=UTF-8''{quote(filename, safe='')}"
            ),
            "Cache-Control": "private, no-store",
            "Content-Security-Policy": "sandbox",
            "X-Content-Type-Options": "nosniff",
        },
    )
