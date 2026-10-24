"""Einheitliche Fehlerantworten (Vertrag Abschnitt 2).

Alle Fehler der API haben dieselbe Form::

    {"error": {"code": "...", "message": "...", ...}, "requestId": "..."}

Endpunkte werfen ``ApiError``; die hier registrierten Handler wandeln
außerdem FastAPI-Validierungsfehler und Routingfehler (404/405) in dieses
Format um. Unerwartete Ausnahmen (500) behandelt die Request-Middleware,
weil sie außerhalb der Starlette-Exception-Handler sitzt.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Iterable, Mapping, Sequence
from enum import StrEnum
from typing import Any, Final

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import OperationalError
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.logs import request_id_var
from app.schemas.base import ApiModel

logger = logging.getLogger(__name__)


class ApiErrorCode(StrEnum):
    """Stabile, maschinenlesbare Fehlercodes für HTTP-Fehlerantworten."""

    INVALID_REQUEST = "invalid-request"
    INVALID_OPTIONS = "invalid-options"
    MISSING_FILE = "missing-file"
    UNSUPPORTED_TYPE = "unsupported-type"
    NOT_PDF = "not-pdf"
    FILE_TOO_LARGE = "file-too-large"
    DIMENSIONS_TOO_LARGE = "dimensions-too-large"
    ANIMATED_UNSUPPORTED = "animated-unsupported"
    ORIGINAL_FORMAT_UNSUPPORTED = "original-format-unsupported"
    INVALID_IDEMPOTENCY_KEY = "invalid-idempotency-key"
    IDEMPOTENCY_CONFLICT = "idempotency-conflict"
    SESSION_REQUIRED = "session-required"
    CSRF_FAILED = "csrf-failed"
    JOB_NOT_FOUND = "job-not-found"
    RESULT_NOT_FOUND = "result-not-found"
    JOB_EXPIRED = "job-expired"
    RATE_LIMITED = "rate-limited"
    SESSION_JOB_LIMIT = "session-job-limit"
    SERVER_BUSY = "server-busy"
    STORAGE_FULL = "storage-full"
    SERVICE_UNAVAILABLE = "service-unavailable"
    INTERNAL_ERROR = "internal-error"
    # Routing (nicht in der Vertragstabelle, für unbekannte Pfade/Methoden).
    NOT_FOUND = "not-found"
    METHOD_NOT_ALLOWED = "method-not-allowed"


class ProcessingErrorCode(StrEnum):
    """Fehlercodes in ``job.error.code`` bzw. ``result.error.code``."""

    DECODE_FAILED = "decode-failed"
    ENCODE_FAILED = "encode-failed"
    SAVE_FAILED = "save-failed"
    ENCRYPTED = "encrypted"
    PARSE_FAILED = "parse-failed"
    RESULT_TOO_LARGE = "result-too-large"
    TIMEOUT = "timeout"
    MEMORY_LIMIT = "memory-limit"
    WORKER_FAILED = "worker-failed"
    STORAGE_FULL = "storage-full"
    DIMENSIONS_TOO_LARGE = "dimensions-too-large"
    ANIMATED_UNSUPPORTED = "animated-unsupported"
    UNSUPPORTED_TYPE = "unsupported-type"


# --- Antwortmodelle (auch Grundlage des OpenAPI-Schemas) -------------------


class FieldError(ApiModel):
    """Ein ungültiges Feld: nur Pfad und Fehlerart, nie der Eingabewert."""

    path: str
    code: str


class ErrorDetail(ApiModel):
    code: ApiErrorCode
    message: str
    retry_after_seconds: int | None = None
    fields: list[FieldError] | None = None


class ErrorResponse(ApiModel):
    error: ErrorDetail
    request_id: str


# Für ``responses=`` an Routen. Endpunkte mit Parametern/Body sollten 422 so
# dokumentieren, sonst setzt FastAPI sein eigenes (abweichendes) Schema ein.
VALIDATION_ERROR_RESPONSE: Final[dict[int | str, dict[str, Any]]] = {
    422: {"model": ErrorResponse, "description": "Anfrage ungültig"},
}
INTERNAL_ERROR_RESPONSE: Final[dict[int | str, dict[str, Any]]] = {
    500: {"model": ErrorResponse, "description": "Unerwarteter Fehler"},
}


class ApiError(Exception):
    """Fachlicher API-Fehler; wird zentral in das Fehlerformat übersetzt."""

    def __init__(
        self,
        code: ApiErrorCode,
        status: int,
        message: str,
        retry_after: int | None = None,
        fields: Sequence[FieldError] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.message = message
        self.retry_after = retry_after
        self.fields = list(fields) if fields is not None else None


def current_request_id() -> str:
    # Die Middleware setzt die ID immer; der Rückfall schützt nur vor einem
    # Aufruf außerhalb einer Anfrage.
    return request_id_var.get() or str(uuid.uuid4())


def error_response(
    code: ApiErrorCode,
    status_code: int,
    message: str,
    *,
    retry_after: int | None = None,
    fields: Sequence[FieldError] | None = None,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    body = ErrorResponse(
        error=ErrorDetail(
            code=code,
            message=message,
            retry_after_seconds=retry_after,
            fields=list(fields) if fields is not None else None,
        ),
        request_id=current_request_id(),
    )
    response_headers = dict(headers or {})
    if retry_after is not None:
        response_headers["Retry-After"] = str(retry_after)
    return JSONResponse(
        status_code=status_code,
        content=body.model_dump(mode="json", exclude_none=True),
        headers=response_headers,
    )


# --- Validierungsfehler -----------------------------------------------------

# Übersetzung häufiger Pydantic-Fehlerarten; sonst wird die Pydantic-Art
# in kebab-case übernommen (z. B. "int_parsing" → "int-parsing").
_FIELD_CODES: Final = {
    "missing": "missing",
    "extra_forbidden": "unknown-field",
    "greater_than": "out-of-range",
    "greater_than_equal": "out-of-range",
    "less_than": "out-of-range",
    "less_than_equal": "out-of-range",
    "literal_error": "invalid-choice",
    "enum": "invalid-choice",
    "json_invalid": "invalid-json",
}


# Pfade bestehen aus Schlüsselnamen des Clients; Länge und Anzahl sind
# begrenzt, damit eine Anfrage keine beliebig große Fehlerantwort erzeugt.
MAX_FIELD_ERRORS: Final = 20
MAX_FIELD_PATH_LENGTH: Final = 64


def _field_path(parts: Sequence[int | str], kind: str) -> str:
    if kind == "extra_forbidden" and parts:
        # Unbekannte Schlüssel stammen vollständig vom Client: Name weglassen,
        # nur das umgebende Objekt nennen.
        parts = parts[:-1]
    return ".".join(str(part) for part in parts)[:MAX_FIELD_PATH_LENGTH]


def fields_from_errors(
    errors: Iterable[Mapping[str, Any]],
    *,
    prefix: str = "",
    skip_segments: frozenset[str] = frozenset(),
    strip_body: bool = True,
) -> list[FieldError]:
    """Pydantic-Fehler → ``fields`` (Pfad + Fehlerart), begrenzt und ohne Werte.

    Bewusst nur "loc" und "type" auswerten: "input", "msg" und "ctx" können
    Eingabewerte enthalten und gehören nicht in die Antwort.
    ``skip_segments`` entfernt Diskriminator-Tags, die Pydantic in den Pfad
    einfügt (z. B. ``("image-convert", "quality")`` → ``quality``).
    """
    fields: list[FieldError] = []
    seen: set[tuple[str, str]] = set()
    for err in errors:
        kind = str(err.get("type", "invalid"))
        loc = list(err.get("loc", ()))
        # "body" ist bei Body-Feldern nur Rauschen ("body.quality" → "quality");
        # "query", "header" und "path" bleiben erhalten.
        if strip_body and loc and loc[0] == "body":
            loc = loc[1:]
        parts = [prefix] if prefix else []
        parts += [part for part in loc if not (isinstance(part, str) and part in skip_segments)]
        field = FieldError(
            path=_field_path(parts, kind) or "body",
            code=_FIELD_CODES.get(kind, kind.replace("_", "-")),
        )
        if (field.path, field.code) in seen:
            continue
        seen.add((field.path, field.code))
        fields.append(field)
        if len(fields) == MAX_FIELD_ERRORS:
            break
    return fields


def validation_fields(exc: RequestValidationError) -> list[FieldError]:
    return fields_from_errors(exc.errors())


# --- Handler ---------------------------------------------------------------


async def _handle_api_error(_request: Request, exc: Exception) -> JSONResponse:
    if not isinstance(exc, ApiError):  # Typverengung für mypy
        raise TypeError(type(exc).__name__)
    return error_response(
        exc.code, exc.status, exc.message, retry_after=exc.retry_after, fields=exc.fields
    )


async def _handle_validation_error(_request: Request, exc: Exception) -> JSONResponse:
    if not isinstance(exc, RequestValidationError):  # Typverengung für mypy
        raise TypeError(type(exc).__name__)
    return error_response(
        ApiErrorCode.INVALID_REQUEST,
        status.HTTP_422_UNPROCESSABLE_CONTENT,
        "Anfrage ist ungültig.",
        fields=validation_fields(exc),
    )


async def _handle_http_exception(_request: Request, exc: Exception) -> JSONResponse:
    """Routing- und Frameworkfehler (z. B. 404, 405, kaputtes Multipart)."""
    if not isinstance(exc, StarletteHTTPException):  # Typverengung für mypy
        raise TypeError(type(exc).__name__)
    headers = dict(exc.headers or {})
    status_code = exc.status_code
    match status_code:
        case 404:
            code, message = ApiErrorCode.NOT_FOUND, "Ressource nicht gefunden."
        case 405:
            code, message = ApiErrorCode.METHOD_NOT_ALLOWED, "Methode nicht erlaubt."
        case 413:
            code, message = ApiErrorCode.FILE_TOO_LARGE, "Anfrage ist zu groß."
        case 503:
            code, message = ApiErrorCode.SERVICE_UNAVAILABLE, "Dienst nicht verfügbar."
        case _ if status_code < 500:
            code, message = ApiErrorCode.INVALID_REQUEST, "Anfrage ist ungültig."
        case _:
            # Sonstige 5xx (z. B. 502) nach außen einheitlich als 500.
            code, message = ApiErrorCode.INTERNAL_ERROR, "Interner Fehler."
            status_code = status.HTTP_500_INTERNAL_SERVER_ERROR
    # exc.detail wird bewusst nicht übernommen: es kann Interna enthalten.
    return error_response(code, status_code, message, headers=headers)


def internal_error_response() -> JSONResponse:
    return error_response(
        ApiErrorCode.INTERNAL_ERROR,
        status.HTTP_500_INTERNAL_SERVER_ERROR,
        "Interner Fehler.",
    )


async def _handle_database_unavailable(_request: Request, exc: Exception) -> JSONResponse:
    """Datenbank nicht erreichbar → 503 service-unavailable (Vertrag §2)."""
    # Nur der Typ: psycopg-Meldungen enthalten Hostnamen und Ports.
    logger.warning("Datenbank nicht erreichbar", extra={"errorType": type(exc).__name__})
    return error_response(
        ApiErrorCode.SERVICE_UNAVAILABLE,
        status.HTTP_503_SERVICE_UNAVAILABLE,
        "Dienst nicht verfügbar.",
        retry_after=5,
    )


def install_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(ApiError, _handle_api_error)
    app.add_exception_handler(RequestValidationError, _handle_validation_error)
    app.add_exception_handler(StarletteHTTPException, _handle_http_exception)
    app.add_exception_handler(OperationalError, _handle_database_unavailable)
