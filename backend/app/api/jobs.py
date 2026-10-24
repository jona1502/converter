"""Auftrags-Endpunkte: anlegen (Upload), abfragen, löschen (Vertrag §4).

``POST /jobs`` ist ``async``, weil er den Body streamend liest. Alle
Datenbank- und Dateioperationen laufen über ``anyio.to_thread`` in einem
Thread, damit ein langsamer Upload keinen anderen Request blockiert.
``GET``/``DELETE`` sind einfache ``def``-Endpunkte (FastAPI nutzt dafür
automatisch einen Thread).
"""

from __future__ import annotations

import functools
import logging
import re
import uuid
from typing import Annotated, Any, Final

import anyio
import anyio.to_thread
from fastapi import APIRouter, Header, Request, Response, status
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.requests import ClientDisconnect

from app.api import API_PREFIX
from app.api.auth import CurrentSessionDep, WriteSessionDep
from app.api.deps import DatabaseDep, SettingsDep, StorageDep
from app.api.errors import ApiError, ApiErrorCode, ErrorResponse, fields_from_errors
from app.api.upload import OPTIONS_MAX_BYTES, FileSink, UploadedFile, boundary_from, read_upload
from app.core.config import Settings
from app.db.engine import Database
from app.jobs.acceptance import (
    Acceptance,
    AcceptedUpload,
    Replay,
    accept_job,
    check_replay_target,
    find_by_idempotency_key,
    fingerprint,
    resolve_replay,
)
from app.jobs.admission import Reservation, release_reservation, reserve_upload
from app.jobs.domain import IMAGE_INPUT_FORMATS, InputFormat, Tool
from app.jobs.queries import load_job, mark_deleted, to_view
from app.jobs.signatures import detect_image_format, is_pdf
from app.schemas.jobs import JobView
from app.schemas.options import JOB_OPTIONS_ADAPTER, ImageOptions, PdfOptions
from app.storage.local import LocalStorage, SpoolWriter

logger = logging.getLogger(__name__)

router = APIRouter(prefix=f"{API_PREFIX}/jobs", tags=["jobs"])

IDEMPOTENCY_KEY_PATTERN: Final = re.compile(r"[A-Za-z0-9_-]{16,128}")
# Puffer für Multipart-Rahmen und Header um Optionen und Datei herum.
MULTIPART_OVERHEAD_BYTES: Final = 64 * 1024

# Diskriminator-Werte, die Pydantic in Fehlerpfade einfügt.
_TAG_SEGMENTS: Final = frozenset(
    {tool.value for tool in Tool} | {"none", "percent", "dimensions", "maxEdge"}
)
# Fehlerarten, die eine formal kaputte Anfrage bedeuten (sonst invalid-options).
_SHAPE_ERRORS: Final = frozenset(
    {"json_invalid", "json_type", "extra_forbidden", "missing", "union_tag_not_found"}
)


def _error_responses(*codes: int) -> dict[int | str, dict[str, Any]]:
    return {code: {"model": ErrorResponse} for code in codes}


# --- Optionen -------------------------------------------------------------------


def parse_options(raw: bytes) -> ImageOptions | PdfOptions:
    try:
        return JOB_OPTIONS_ADAPTER.validate_json(raw)
    except ValidationError as exc:
        errors = exc.errors()
        shape = any(
            str(err["type"]) in _SHAPE_ERRORS or str(err["type"]).endswith(("_type", "_parsing"))
            for err in errors
        )
        fields = fields_from_errors(errors, prefix="options", skip_segments=_TAG_SEGMENTS)
        if shape:
            raise ApiError(
                ApiErrorCode.INVALID_REQUEST, 422, "options ist ungültig.", fields=fields
            ) from None
        raise ApiError(
            ApiErrorCode.INVALID_OPTIONS, 422, "Optionen ungültig.", fields=fields
        ) from None


def input_limit(settings: Settings, options: ImageOptions | PdfOptions) -> int:
    if isinstance(options, PdfOptions):
        return settings.pdf_max_input_bytes
    return settings.image_max_input_bytes


def detect_input_format(options: ImageOptions | PdfOptions, head: bytes) -> InputFormat:
    """Vertrag §4 Schritt 7: Signatur prüfen, ``original`` auflösen."""
    if isinstance(options, PdfOptions):
        if not is_pdf(head):
            raise ApiError(ApiErrorCode.NOT_PDF, 415, "Keine PDF-Signatur.")
        return InputFormat.PDF
    detected = detect_image_format(head)
    if detected is None or detected not in IMAGE_INPUT_FORMATS:
        raise ApiError(ApiErrorCode.UNSUPPORTED_TYPE, 415, "Format nicht unterstützt.")
    if options.output_format(detected.value) is None:
        raise ApiError(
            ApiErrorCode.ORIGINAL_FORMAT_UNSUPPORTED,
            422,
            "Eingabeformat ist kein Ausgabeformat.",
        )
    if options.format == "original" and detected is InputFormat.ICO:
        if options.resize.mode != "none":
            raise ApiError(ApiErrorCode.INVALID_OPTIONS, 422, "Bei ICO kein resize.")
    elif options.ico_sizes is not None and options.output_format(detected.value) != "ico":
        raise ApiError(ApiErrorCode.INVALID_OPTIONS, 422, "icoSizes nur bei ICO.")
    # Header-Probe (Abmessungen, Animation) folgt mit Pillow in B05.
    return detected


# --- Spool --------------------------------------------------------------------


class _SpoolSink:
    """Schreibt Dateibytes in die Spool-Datei, ohne die Event-Loop zu blockieren."""

    def __init__(self, writer: SpoolWriter) -> None:
        self.writer = writer

    async def write(self, data: bytes) -> None:
        await anyio.to_thread.run_sync(self.writer.write, data)


class _HashOnlySink:
    """Für Wiederholungen: nichts speichern, nur zählen und hashen."""

    async def write(self, data: bytes) -> None:
        return None


async def _read_body(
    request: Request,
    settings: Settings,
    sink_factory: Any,
) -> tuple[ImageOptions | PdfOptions, UploadedFile]:
    boundary = boundary_from(request.headers.get("content-type"))
    parsed: list[ImageOptions | PdfOptions] = []

    def on_options(raw: bytes) -> int:
        options = parse_options(raw)
        parsed.append(options)
        return input_limit(settings, options)

    try:
        with anyio.fail_after(settings.upload_max_seconds):
            upload = await read_upload(
                request.stream(),
                boundary,
                on_options=on_options,
                sink_for=sink_factory,
                max_body_bytes=(
                    settings.max_upload_input_bytes + OPTIONS_MAX_BYTES + MULTIPART_OVERHEAD_BYTES
                ),
            )
    except TimeoutError:
        raise ApiError(
            ApiErrorCode.INVALID_REQUEST, 408, "Upload-Zeitlimit überschritten."
        ) from None
    except ClientDisconnect:
        raise ApiError(ApiErrorCode.INVALID_REQUEST, 400, "Upload abgebrochen.") from None
    return parsed[0], upload


def _check_declared_length(request: Request, settings: Settings) -> None:
    """Offensichtlich zu große Uploads sofort ablehnen (Längenangabe nur als
    Vorabprüfung; maßgeblich ist das Zählen beim Lesen)."""
    declared = request.headers.get("content-length")
    limit = settings.max_upload_input_bytes + OPTIONS_MAX_BYTES + MULTIPART_OVERHEAD_BYTES
    if declared is not None and declared.isdigit() and int(declared) > limit:
        raise ApiError(
            ApiErrorCode.FILE_TOO_LARGE,
            413,
            f"Datei überschreitet {settings.max_upload_input_bytes} Bytes.",
        )


async def _replay(
    request: Request,
    settings: Settings,
    database: Database,
    session_id: uuid.UUID,
    key: str,
) -> Acceptance:
    # B09: eigenes Wiederholungslimit und höchstens ein gleichzeitiger
    # Wiederholungs-Upload je Sitzung (Vertrag §4 Schritt 2).
    async def sink() -> FileSink:
        return _HashOnlySink()

    options, upload = await _read_body(request, settings, sink)
    request_fingerprint = fingerprint(options, upload.sha256, upload.size)
    return await anyio.to_thread.run_sync(
        resolve_replay, database, session_id, key, request_fingerprint
    )


async def _create(
    request: Request,
    settings: Settings,
    database: Database,
    storage: LocalStorage,
    session_id: uuid.UUID,
    key: str | None,
) -> Acceptance:
    reservation: Reservation = await anyio.to_thread.run_sync(
        reserve_upload, database, settings, session_id
    )
    writers: list[SpoolWriter] = []

    async def sink() -> FileSink:
        writer = await anyio.to_thread.run_sync(storage.create, reservation.spool_key)
        writers.append(writer)
        return _SpoolSink(writer)

    accepted = False
    try:
        options, upload = await _read_body(request, settings, sink)
        input_format = detect_input_format(options, bytes(upload.head))
        for writer in writers:
            await anyio.to_thread.run_sync(writer.close)
        if isinstance(options, ImageOptions):
            from app.jobs.image_probe import probe_image

            await anyio.to_thread.run_sync(
                probe_image, storage.path_for(reservation.spool_key), settings
            )
        result = await anyio.to_thread.run_sync(
            functools.partial(
                accept_job,
                database,
                storage,
                settings,
                session_id=session_id,
                reservation=reservation,
                upload=AcceptedUpload(
                    options=options,
                    original_name=upload.original_name,
                    size=upload.size,
                    sha256=upload.sha256,
                    input_format=input_format,
                ),
                idempotency_key=key,
            )
        )
        accepted = True
        return result
    finally:
        if not accepted:
            # Auch bei Abbruch (Client trennt, Server fährt herunter): Spool
            # löschen und Reservierung sofort freigeben. accept_job räumt
            # seine eigenen Fehlerfälle selbst auf; doppeltes Aufräumen ist
            # harmlos (Löschen ist idempotent).
            with anyio.CancelScope(shield=True):
                for writer in writers:
                    await anyio.to_thread.run_sync(writer.discard)
                await anyio.to_thread.run_sync(storage.delete, reservation.spool_key)
                await anyio.to_thread.run_sync(release_reservation, database, reservation.id)


def _job_response(acceptance: Acceptance) -> JSONResponse:
    view = to_view(acceptance.loaded)
    replayed = acceptance.replay is Replay.REPLAYED
    headers = {"Location": f"{API_PREFIX}/jobs/{view.id}"}
    if replayed:
        headers["Idempotent-Replayed"] = "true"
    return JSONResponse(
        view.model_dump(mode="json"),
        status_code=status.HTTP_200_OK if replayed else status.HTTP_202_ACCEPTED,
        headers=headers,
    )


_MULTIPART_BODY: Final = {
    "requestBody": {
        "required": True,
        "content": {
            "multipart/form-data": {
                "schema": {
                    "type": "object",
                    "required": ["options", "file"],
                    "properties": {
                        "options": {
                            "type": "string",
                            "description": "JSON nach JobOptions, höchstens 8 KiB; erster Teil",
                        },
                        "file": {"type": "string", "format": "binary"},
                    },
                }
            }
        },
    }
}


@router.post(
    "",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=JobView,
    summary="Auftrag anlegen (Datei hochladen)",
    openapi_extra=_MULTIPART_BODY,
    responses={
        200: {"model": JobView, "description": "Wiederholung (Idempotent-Replayed: true)"},
        **_error_responses(400, 401, 403, 404, 408, 409, 410, 413, 415, 422, 503),
    },
)
async def create_job(
    request: Request,
    session: WriteSessionDep,
    settings: SettingsDep,
    database: DatabaseDep,
    storage: StorageDep,
    idempotency_key: Annotated[str | None, Header()] = None,
) -> Response:
    if idempotency_key is not None and not IDEMPOTENCY_KEY_PATTERN.fullmatch(idempotency_key):
        raise ApiError(
            ApiErrorCode.INVALID_IDEMPOTENCY_KEY, 422, "Idempotency-Key hat ein falsches Format."
        )
    boundary_from(request.headers.get("content-type"))
    _check_declared_length(request, settings)

    if idempotency_key is not None:

        def lookup() -> bool:
            with database.session() as db:
                existing = find_by_idempotency_key(db, session.id, idempotency_key)
                if existing is not None:
                    check_replay_target(existing)
                return existing is not None

        if await anyio.to_thread.run_sync(lookup):
            acceptance = await _replay(request, settings, database, session.id, idempotency_key)
            return _job_response(acceptance)

    acceptance = await _create(request, settings, database, storage, session.id, idempotency_key)
    return _job_response(acceptance)


def _parse_job_id(job_id: str) -> uuid.UUID:
    # Ungültige IDs verhalten sich wie unbekannte (kein 422, das IDs verriete).
    try:
        return uuid.UUID(job_id)
    except ValueError:
        raise ApiError(ApiErrorCode.JOB_NOT_FOUND, 404, "Auftrag nicht gefunden.") from None


@router.get(
    "/{job_id}",
    summary="Auftrag abfragen",
    responses=_error_responses(401, 404, 422),
)
def get_job(job_id: str, session: CurrentSessionDep, database: DatabaseDep) -> JobView:
    with database.session() as db:
        loaded = load_job(db, _parse_job_id(job_id), session.id)
    if loaded is None:
        raise ApiError(ApiErrorCode.JOB_NOT_FOUND, 404, "Auftrag nicht gefunden.")
    return to_view(loaded)


@router.delete(
    "/{job_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Auftrag löschen",
    responses=_error_responses(401, 403, 404, 422),
)
def delete_job(job_id: str, session: WriteSessionDep, database: DatabaseDep) -> Response:
    with database.session() as db, db.begin():
        deleted = mark_deleted(db, _parse_job_id(job_id), session.id)
    if not deleted:
        raise ApiError(ApiErrorCode.JOB_NOT_FOUND, 404, "Auftrag nicht gefunden.")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
