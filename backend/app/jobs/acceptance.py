"""Auftragsannahme in einer Transaktion und Idempotenz (Vertrag §4 Schritt 8).

In **einer** Transaktion: Reservierung auflösen und auf die tatsächliche
Größe kürzen, Auftrag (``queued``), Ergebniszeilen (``pending``) und
Outbox-Eintrag anlegen, Spool-Datei an den finalen Ort verschieben. Erst nach
dem Commit gilt der Auftrag als angenommen. Scheitert irgendetwas, werden
Datei und Reservierung wieder entfernt.
"""

from __future__ import annotations

import hashlib
import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import Enum
from typing import Any

from sqlalchemy import func, insert, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.errors import ApiError, ApiErrorCode
from app.core.config import Settings
from app.db.engine import Database
from app.db.models import Job, JobResult, OutboxEntry
from app.jobs.admission import Reservation, release_bytes, release_reservation, take_reservation
from app.jobs.domain import (
    OUTPUT_MIME,
    PDF_MIME,
    InputFormat,
    JobState,
    OutboxKind,
    PdfLevel,
    Tool,
)
from app.jobs.naming import (
    IMAGE_FALLBACK_BASE,
    PDF_FALLBACK_BASE,
    display_name,
    image_download_name,
    pdf_download_name,
)
from app.jobs.queries import LoadedJob, is_expired, load_job
from app.schemas.options import ImageOptions, PdfOptions, canonical_json, canonical_options
from app.storage.local import LocalStorage, input_key

logger = logging.getLogger(__name__)

IDEMPOTENCY_CONSTRAINT = "uq_jobs_session_id_idempotency_key"


@dataclass(frozen=True)
class AcceptedUpload:
    """Alles, was nach dem Upload über die Eingabe feststeht."""

    options: ImageOptions | PdfOptions
    original_name: str
    size: int
    sha256: bytes
    input_format: InputFormat


def fingerprint(options: ImageOptions | PdfOptions, sha256: bytes, size: int) -> bytes:
    """SHA-256 über Werkzeug, kanonische Optionen, Datei-Hash und -Größe."""
    payload = {
        "tool": options.tool.value,
        "options": canonical_options(options),
        "fileSha256": sha256.hex(),
        "fileSize": size,
    }
    return hashlib.sha256(canonical_json(payload)).digest()


class Replay(Enum):
    NEW = "new"
    REPLAYED = "replayed"


@dataclass(frozen=True)
class Acceptance:
    loaded: LoadedJob
    replay: Replay


# --- Idempotenz ---------------------------------------------------------------


def find_by_idempotency_key(db: Session, session_id: uuid.UUID, key: str) -> Job | None:
    return db.execute(
        select(Job).where(Job.session_id == session_id, Job.idempotency_key == key)
    ).scalar_one_or_none()


def check_replay_target(job: Job, now: datetime | None = None) -> None:
    """Gelöscht → 404, abgelaufen → 410 (Vertrag §4 Schritt 2)."""
    if job.deleted_at is not None:
        raise ApiError(ApiErrorCode.JOB_NOT_FOUND, 404, "Auftrag nicht gefunden.")
    if is_expired(job, now or datetime.now(UTC)):
        raise ApiError(ApiErrorCode.JOB_EXPIRED, 410, "Auftrag abgelaufen.")


def resolve_replay(
    database: Database, session_id: uuid.UUID, key: str, request_fingerprint: bytes
) -> Acceptance:
    """Vergleicht eine Wiederholung mit dem vorhandenen Auftrag."""
    with database.session() as db, db.begin():
        job = find_by_idempotency_key(db, session_id, key)
        if job is None:  # pragma: no cover - nur bei gleichzeitiger Metadatenbereinigung
            raise ApiError(ApiErrorCode.JOB_NOT_FOUND, 404, "Auftrag nicht gefunden.")
        check_replay_target(job)
        if job.fingerprint != request_fingerprint:
            raise ApiError(
                ApiErrorCode.IDEMPOTENCY_CONFLICT, 409, "Idempotency-Key mit anderer Anfrage."
            )
        loaded = load_job(db, job.id, session_id)
    if loaded is None:  # pragma: no cover - siehe oben
        raise ApiError(ApiErrorCode.JOB_NOT_FOUND, 404, "Auftrag nicht gefunden.")
    return Acceptance(loaded=loaded, replay=Replay.REPLAYED)


# --- Annahme --------------------------------------------------------------------


def _result_rows(job_id: uuid.UUID, upload: AcceptedUpload) -> list[dict[str, Any]]:
    options = upload.options
    if isinstance(options, PdfOptions):
        return [
            {
                "id": uuid.uuid4(),
                "job_id": job_id,
                "ordinal": ordinal,
                "level": level.value,
                "mime": PDF_MIME,
                "download_name": pdf_download_name(upload.original_name, PdfLevel(level)),
            }
            for ordinal, level in enumerate(options.levels)
        ]
    output = options.output_format(upload.input_format.value)
    if output is None:  # vorher geprüft (original-format-unsupported)
        raise ValueError("Zielformat nicht erzeugbar")
    return [
        {
            "id": uuid.uuid4(),
            "job_id": job_id,
            "ordinal": 0,
            "level": None,
            "mime": OUTPUT_MIME[output],
            "download_name": image_download_name(
                upload.original_name, Tool(options.tool), upload.input_format, output
            ),
        }
    ]


def _insert_outbox(db: Session, job_id: uuid.UUID) -> None:
    db.execute(insert(OutboxEntry).values(kind=OutboxKind.DISPATCH.value, job_id=job_id))


def _is_idempotency_conflict(exc: IntegrityError) -> bool:
    diag = getattr(exc.orig, "diag", None)
    return getattr(diag, "constraint_name", None) == IDEMPOTENCY_CONSTRAINT


def accept_job(
    database: Database,
    storage: LocalStorage,
    settings: Settings,
    *,
    session_id: uuid.UUID,
    reservation: Reservation,
    upload: AcceptedUpload,
    idempotency_key: str | None,
) -> Acceptance:
    job_id = uuid.uuid4()
    target_key = input_key(job_id)
    request_fingerprint = (
        fingerprint(upload.options, upload.sha256, upload.size) if idempotency_key else None
    )
    fallback = PDF_FALLBACK_BASE if upload.input_format is InputFormat.PDF else IMAGE_FALLBACK_BASE
    try:
        with database.session() as db, db.begin():
            reserved = take_reservation(db, reservation.id)
            if reserved is None:
                # Cleanup hat die abgelaufene Reservierung bereits entfernt.
                raise ApiError(
                    ApiErrorCode.SERVICE_UNAVAILABLE, 503, "Upload-Reservierung abgelaufen."
                )
            # Reservierung auf die tatsächliche Größe kürzen (Vertrag §7).
            release_bytes(db, reserved - upload.size)
            db.execute(
                insert(Job).values(
                    id=job_id,
                    session_id=session_id,
                    tool=upload.options.tool.value,
                    state=JobState.QUEUED.value,
                    options=canonical_options(upload.options),
                    input_name=display_name(upload.original_name, fallback),
                    input_size=upload.size,
                    input_format=upload.input_format.value,
                    input_sha256=upload.sha256,
                    input_storage_key=target_key,
                    idempotency_key=idempotency_key,
                    fingerprint=request_fingerprint,
                    max_attempts=settings.job_max_attempts,
                    expires_at=func.now() + timedelta(seconds=settings.job_ttl_seconds),
                    reserved_bytes=upload.size,
                )
            )
            db.execute(insert(JobResult), _result_rows(job_id, upload))
            _insert_outbox(db, job_id)
            # Datei erst verschieben, wenn alle Zeilen geschrieben sind;
            # der Commit folgt direkt danach (Ende des begin-Blocks).
            storage.promote(reservation.spool_key, target_key)
    except IntegrityError as exc:
        _cleanup(database, storage, reservation, target_key)
        if (
            idempotency_key is not None
            and request_fingerprint is not None
            and (_is_idempotency_conflict(exc))
        ):
            # Gleichzeitige Wiederholung hat den Insert gewonnen (Vertrag §4).
            return resolve_replay(database, session_id, idempotency_key, request_fingerprint)
        raise
    except BaseException:
        _cleanup(database, storage, reservation, target_key)
        raise
    # Ab hier ist der Auftrag committet; Fehler beim Lesen dürfen die Datei
    # nicht mehr entfernen.
    with database.session() as db:
        loaded = load_job(db, job_id, session_id)
    if loaded is None:  # pragma: no cover - gerade angelegt
        raise RuntimeError("angenommener Auftrag nicht lesbar")
    return Acceptance(loaded=loaded, replay=Replay.NEW)


def _cleanup(
    database: Database, storage: LocalStorage, reservation: Reservation, moved_key: str | None
) -> None:
    """Datei und Reservierung entfernen, wenn die Annahme scheitert."""
    if moved_key is not None:
        storage.delete(moved_key)
    storage.delete(reservation.spool_key)
    release_reservation(database, reservation.id)
