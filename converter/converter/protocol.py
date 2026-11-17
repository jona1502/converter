"""Prozessprotokoll Go-Worker ↔ Konverter, Version 1.

Anfrage: genau ein JSON-Objekt über stdin (höchstens ``MAX_REQUEST_BYTES``)::

    {"protocolVersion": 1,
     "source": "/abs/input",
     "options": {...Vertrag §4...},
     "results": [{"id": "<uuid>", "level": null | "high" | ..., "path": "/abs/out"}],
     "limits": {"imageMaxInputBytes": ..., "imageMaxPixels": ..., "imageMaxEdge": ...,
                "imageMaxOutputBytes": ..., "pdfMaxInputBytes": ...,
                "pdfMaxResultsTotalBytes": ..., "pdfImageMaxPixels": ...,
                "audioMaxInputBytes": ..., "audioMaxDurationSeconds": ...,
                "audioMaxChannels": ..., "audioMaxSampleRate": ...,
                "audioMaxOutputBytes": ...},
     "memory": <RLIMIT_AS Bytes>, "timeout": <Sekunden>, "outputLimit": <RLIMIT_FSIZE Bytes>}

Alle Felder sind Pflicht, unbekannte Felder und doppelte Schlüssel sind Fehler.
Go erzeugt alle Pfade und die leeren Ergebnisdateien; der Konverter legt keine
Dateien an, folgt keinen Symlinks und schreibt nur in diese Dateien.

Ereignisse: JSONL über stdout, kompakt, ASCII, jede Zeile < ``MAX_EVENT_BYTES``::

    {"kind":"progress","phase":"encode"}                                  Bild, Audio
    {"kind":"analysis","analysis":{...PdfAnalysis...}}                    PDF, genau einmal
    {"kind":"progress","phase":"variant",
     "progress":{"step":"variant","level":"high","current":3,"total":12}} PDF, gedrosselt
    {"kind":"result","id":"<uuid>","details":{...}}                      Ergebnis fertig
    {"kind":"error","id":"<uuid>","code":"<RESULT_CODES>"}                Ergebnis gescheitert
    {"kind":"fatal","code":"<FATAL_CODES>"}                               Auftrag gescheitert

Nach ``fatal`` endet der Prozess mit Exit-Code 1, sonst 0. Ereignisse
enthalten nie Pfade, Dateinamen, Inhalte oder Ausnahmetexte. Größen meldet
der Konverter bewusst nicht: Go misst sie im Dateisystem.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Any, Final

from converter import validation as v
from converter.errors import ProtocolError
from converter.limits import Limits, parse_limits
from converter.options import AudioOptions, ImageOptions, JobOptions, MarkdownOptions, parse_options

PROTOCOL_VERSION: Final = 1
MAX_REQUEST_BYTES: Final = 64 * 1024
MAX_EVENT_BYTES: Final = 64 * 1024  # inklusive Zeilenende
CODE: Final = "protocol-error"
MAX_PATH: Final = 4096
MAX_MEMORY: Final = 1 << 40
MAX_TIMEOUT: Final = 3600
MAX_OUTPUT: Final = 1 << 40
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_FIELDS: Final = (
    "protocolVersion",
    "source",
    "options",
    "results",
    "limits",
    "memory",
    "timeout",
    "outputLimit",
)

# Codes je Ergebnis: Vertrag §2 (ProcessingErrorCode bzw. ApiErrorCode).
RESULT_CODES: Final = frozenset(
    {
        "decode-failed",
        "encode-failed",
        "save-failed",
        "encrypted",
        "parse-failed",
        "not-pdf",
        "file-too-large",
        "result-too-large",
        "memory-limit",
        "dimensions-too-large",
        "animated-unsupported",
        "unsupported-type",
        "original-format-unsupported",
        "invalid-options",
        "duration-too-long",
        "unsupported-audio",
    }
)
# protocol-error/sandbox-failed sind intern: Go bildet sie auf worker-failed ab.
FATAL_CODES: Final = RESULT_CODES | {"protocol-error", "sandbox-failed", "worker-failed"}


@dataclass(frozen=True, slots=True)
class ResultTarget:
    id: str
    level: str | None
    path: str


@dataclass(frozen=True, slots=True)
class Request:
    source: str
    options: JobOptions
    results: tuple[ResultTarget, ...]
    limits: Limits
    memory: int
    timeout: int
    output_limit: int


def _reject_constant(_: str) -> None:
    raise ProtocolError(CODE, "request: NaN/Infinity not allowed")


def _unique_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ProtocolError(CODE, "request: duplicate key")
        result[key] = value
    return result


def _absolute(value: object, where: str) -> str:
    path = v.string(value, code=CODE, where=where, max_length=MAX_PATH)
    if not path or "\x00" in path:
        raise v.fail(CODE, f"{where}: invalid path")
    # Absolut nach den Regeln des ausführenden Systems (Container: POSIX).
    if not Path(path).is_absolute():
        raise v.fail(CODE, f"{where}: absolute path required")
    return path


def _results(value: object, options: JobOptions) -> tuple[ResultTarget, ...]:
    items = v.array(value, code=CODE, where="results", max_items=3)
    targets: list[ResultTarget] = []
    for index, item in enumerate(items):
        where = f"results[{index}]"
        raw = v.obj(item, required=("id", "level", "path"), code=CODE, where=where)
        result_id = v.string(raw["id"], code=CODE, where=f"{where}.id", max_length=36)
        if _UUID.fullmatch(result_id) is None:
            raise v.fail(CODE, f"{where}.id: uuid expected")
        level = raw["level"]
        if level is not None and type(level) is not str:
            raise v.fail(CODE, f"{where}.level: string or null expected")
        targets.append(ResultTarget(result_id, level, _absolute(raw["path"], f"{where}.path")))
    if isinstance(options, ImageOptions | AudioOptions | MarkdownOptions):
        expected: list[str | None] = [None]
    else:
        expected = list(options.levels)
    if [target.level for target in targets] != expected:
        raise v.fail(CODE, "results: levels do not match options")
    if len({target.id for target in targets}) != len(targets):
        raise v.fail(CODE, "results: duplicate id")
    return tuple(targets)


def parse_request(raw: bytes) -> Request:
    """Prüft die vollständige Anfrage; Fehler: ``ProtocolError``."""
    if len(raw) > MAX_REQUEST_BYTES:
        raise ProtocolError(CODE, "request: too large")
    try:
        text = raw.decode("utf-8")
        value = json.loads(text, object_pairs_hook=_unique_keys, parse_constant=_reject_constant)
    except ProtocolError:
        raise
    except (UnicodeDecodeError, ValueError, RecursionError) as exc:
        raise ProtocolError(CODE, "request: invalid JSON") from exc
    request = v.obj(value, required=_FIELDS, code=CODE, where="request")
    version = request["protocolVersion"]
    if type(version) is not int or version != PROTOCOL_VERSION:
        raise ProtocolError(CODE, "request: unsupported protocolVersion")
    source = _absolute(request["source"], "source")
    options = parse_options(request["options"])
    results = _results(request["results"], options)
    if source in {target.path for target in results} or len(
        {target.path for target in results}
    ) != len(results):
        raise v.fail(CODE, "results: paths must be distinct")
    return Request(
        source=source,
        options=options,
        results=results,
        limits=parse_limits(request["limits"]),
        memory=v.integer(
            request["memory"], code=CODE, where="memory", minimum=1, maximum=MAX_MEMORY
        ),
        timeout=v.integer(
            request["timeout"], code=CODE, where="timeout", minimum=1, maximum=MAX_TIMEOUT
        ),
        output_limit=v.integer(
            request["outputLimit"], code=CODE, where="outputLimit", minimum=1, maximum=MAX_OUTPUT
        ),
    )


def encode_event(event: dict[str, Any]) -> bytes:
    line = json.dumps(event, separators=(",", ":"), ensure_ascii=True, allow_nan=False) + "\n"
    data = line.encode("ascii")
    if len(data) > MAX_EVENT_BYTES:
        raise ValueError("event too large")
    return data


class EventWriter:
    """Schreibt Ereignisse zeilenweise und sofort (Go liest parallel)."""

    def __init__(self, stream: IO[bytes]) -> None:
        self._stream = stream

    def _emit(self, event: dict[str, Any]) -> None:
        self._stream.write(encode_event(event))
        self._stream.flush()

    def progress_encode(self) -> None:
        self._emit({"kind": "progress", "phase": "encode"})

    def progress_variant(self, level: str, current: int, total: int) -> None:
        self._emit(
            {
                "kind": "progress",
                "phase": "variant",
                "progress": {"step": "variant", "level": level, "current": current, "total": total},
            }
        )

    def analysis(self, analysis: dict[str, Any]) -> None:
        self._emit({"kind": "analysis", "analysis": analysis})

    def result(self, result_id: str, details: dict[str, Any]) -> None:
        self._emit({"kind": "result", "id": result_id, "details": details})

    def error(self, result_id: str, code: str, fallback: str) -> None:
        self._emit(
            {"kind": "error", "id": result_id, "code": code if code in RESULT_CODES else fallback}
        )

    def fatal(self, code: str) -> None:
        self._emit({"kind": "fatal", "code": code if code in FATAL_CODES else "worker-failed"})
