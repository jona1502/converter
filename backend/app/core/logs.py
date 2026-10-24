"""Strukturiertes Logging als JSON-Zeilen.

Jede Logzeile ist ein JSON-Objekt, damit Logs maschinell auswertbar sind.
Es werden nur ausdrücklich erlaubte Zusatzfelder ausgegeben (Allowlist), damit
niemand versehentlich Request-Bodies, Cookies, CSRF-Tokens oder Dateinamen
loggt: ``logger.info("...", extra={"cookie": ...})`` erscheint schlicht nicht.
"""

from __future__ import annotations

import json
import logging
import sys
import traceback
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import Final

# Request-ID der laufenden Anfrage; gesetzt von der Request-Middleware.
request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)

# Felder, die über ``extra=`` in die Logzeile übernommen werden dürfen.
ALLOWED_EXTRA_FIELDS: Final = frozenset(
    {"requestId", "method", "route", "status", "durationMs", "check", "jobId", "errorType"}
)

_HANDLER_MARKER: Final = "_converter_json_handler"


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, object] = {
            "ts": datetime.fromtimestamp(record.created, tz=UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        request_id = request_id_var.get()
        if request_id is not None:
            entry["requestId"] = request_id
        for field in ALLOWED_EXTRA_FIELDS:
            if field in record.__dict__:
                entry[field] = record.__dict__[field]
        if record.exc_info and record.exc_info[1] is not None:
            entry.update(describe_exception(record.exc_info[1]))
        return json.dumps(entry, ensure_ascii=False, default=str)


def _type_name(exc: BaseException) -> str:
    cls = type(exc)
    return (
        cls.__qualname__ if cls.__module__ == "builtins" else f"{cls.__module__}.{cls.__qualname__}"
    )


def describe_exception(exc: BaseException) -> dict[str, object]:
    """Ausnahme ohne Meldungstext beschreiben (Vertrag Abschnitt 2).

    Meldungen enthalten oft Pfade, Dateinamen oder Eingabewerte. Geloggt
    werden deshalb nur der Typ, die Typen verketteter Ursachen und die
    Stack-Frames (Datei, Zeile, Funktion) – keine Meldung, keine Locals.
    """
    stack = [
        f"{frame.filename}:{frame.lineno} in {frame.name}"
        for frame in traceback.extract_tb(exc.__traceback__)
    ]
    causes: list[str] = []
    current = exc.__cause__ or exc.__context__
    while current is not None and len(causes) < 5:
        causes.append(_type_name(current))
        current = current.__cause__ or current.__context__
    described: dict[str, object] = {"exceptionType": _type_name(exc), "stack": stack}
    if causes:
        described["causedBy"] = causes
    return described


def configure_logging(level: str) -> None:
    """Richtet JSON-Logging für Root- und uvicorn-Logger ein (idempotent)."""
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    setattr(handler, _HANDLER_MARKER, True)

    root = logging.getLogger()
    root.handlers = [h for h in root.handlers if not getattr(h, _HANDLER_MARKER, False)]
    root.addHandler(handler)
    root.setLevel(level)

    # uvicorn bringt eigene Handler mit; wir leiten seine Meldungen in das
    # JSON-Format um. Das Zugriffslog von uvicorn enthält Client-IP und rohe
    # URL inklusive Query – es wird abgeschaltet, die Middleware loggt selbst.
    uvicorn_logger = logging.getLogger("uvicorn")
    uvicorn_logger.handlers = []
    uvicorn_logger.propagate = True
    access_logger = logging.getLogger("uvicorn.access")
    access_logger.handlers = []
    access_logger.propagate = False
    access_logger.disabled = True
