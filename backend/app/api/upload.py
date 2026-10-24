"""Streamendes Lesen von ``multipart/form-data`` für ``POST /api/v1/jobs``.

Warum nicht ``Form``/``UploadFile``? FastAPI liest damit den gesamten Body,
bevor der Endpunkt läuft – ohne Größenlimit und vor jeder Prüfung. Hier
wird ``request.stream()`` stückweise an den Parser von ``python-multipart``
gegeben (Vertrag §4 Schritt 4–6):

1. Der erste Teil muss ``options`` sein (höchstens 8 KiB). Er wird geprüft,
   **bevor** Dateibytes verarbeitet werden.
2. Der zweite Teil ist ``file``. Seine Bytes gehen an eine ``FileSink``
   (Spool-Datei oder nur Hash), werden gezählt und mit SHA-256 gehasht.
   ``Content-Length`` wird nicht vertraut; das Limit greift beim Zählen.
3. Weitere Teile sind Fehler.

Parser-Callbacks sind synchron; sie sammeln nur Ereignisse. Die eigentliche
Arbeit (z. B. Schreiben in die Datei) passiert danach im async-Code.
"""

from __future__ import annotations

import hashlib
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Final, Protocol

from python_multipart.exceptions import MultipartParseError
from python_multipart.multipart import MultipartParser, parse_options_header

from app.api.errors import ApiError, ApiErrorCode
from app.jobs.signatures import SNIFF_BYTES

OPTIONS_MAX_BYTES: Final = 8 * 1024
MAX_PART_HEADER_BYTES: Final = 8 * 1024
MAX_FILENAME_BYTES: Final = 1024
PARSER_CHUNK_BYTES: Final = 64 * 1024


class FileSink(Protocol):
    async def write(self, data: bytes) -> None: ...


@dataclass
class UploadedFile:
    original_name: str
    size: int = 0
    head: bytearray = field(default_factory=bytearray)
    _hash: hashlib._Hash = field(default_factory=hashlib.sha256)

    def feed(self, data: bytes) -> None:
        self.size += len(data)
        self._hash.update(data)
        if len(self.head) < SNIFF_BYTES:
            self.head += data[: SNIFF_BYTES - len(self.head)]

    @property
    def sha256(self) -> bytes:
        return self._hash.digest()


def invalid_request(message: str, status: int = 422) -> ApiError:
    return ApiError(ApiErrorCode.INVALID_REQUEST, status, message)


def boundary_from(content_type: str | None) -> bytes:
    if not content_type:
        raise invalid_request("multipart/form-data erwartet.", 400)
    media_type, params = parse_options_header(content_type)
    boundary = params.get(b"boundary")
    if media_type != b"multipart/form-data" or not boundary or len(boundary) > 200:
        raise invalid_request("multipart/form-data mit boundary erwartet.", 400)
    return boundary


@dataclass
class _Part:
    headers: list[tuple[bytes, bytes]] = field(default_factory=list)
    header_bytes: int = 0
    name: str | None = None
    filename: str | None = None


class _Events:
    """Sammelt Parser-Ereignisse zwischen zwei ``parser.write``-Aufrufen."""

    def __init__(self) -> None:
        self.items: list[tuple[str, bytes]] = []
        self.field = bytearray()
        self.value = bytearray()
        self.ended = False

    def callbacks(self) -> dict[str, Callable[..., None]]:
        def on_part_begin() -> None:
            self.items.append(("begin", b""))

        def on_header_field(data: bytes, start: int, end: int) -> None:
            self.field += data[start:end]

        def on_header_value(data: bytes, start: int, end: int) -> None:
            self.value += data[start:end]

        def on_header_end() -> None:
            self.items.append(("header", bytes(self.field) + b"\x00" + bytes(self.value)))
            self.field.clear()
            self.value.clear()

        def on_headers_finished() -> None:
            self.items.append(("headers_done", b""))

        def on_part_data(data: bytes, start: int, end: int) -> None:
            self.items.append(("data", bytes(data[start:end])))

        def on_part_end() -> None:
            self.items.append(("end", b""))

        def on_end() -> None:
            self.ended = True

        return {
            "on_part_begin": on_part_begin,
            "on_header_field": on_header_field,
            "on_header_value": on_header_value,
            "on_header_end": on_header_end,
            "on_headers_finished": on_headers_finished,
            "on_part_data": on_part_data,
            "on_part_end": on_part_end,
            "on_end": on_end,
        }


def _disposition(part: _Part) -> None:
    for name, value in part.headers:
        if name.lower() == b"content-disposition":
            kind, params = parse_options_header(value)
            if kind != b"form-data":
                raise invalid_request("Content-Disposition form-data erwartet.", 400)
            raw_name = params.get(b"name")
            part.name = raw_name.decode("utf-8", "replace") if raw_name is not None else None
            raw_filename = params.get(b"filename")
            if raw_filename is not None:
                part.filename = raw_filename[:MAX_FILENAME_BYTES].decode("utf-8", "replace")
            return
    raise invalid_request("Content-Disposition fehlt.", 400)


async def read_upload(
    stream: AsyncIterator[bytes],
    boundary: bytes,
    *,
    on_options: Callable[[bytes], int],
    sink_for: Callable[[], Awaitable[FileSink]],
    max_body_bytes: int = 100_000_000 + 72 * 1024,
) -> UploadedFile:
    """Liest den Body und liefert die Kennzahlen der Datei.

    ``on_options`` erhält die rohen Options-Bytes, prüft sie (wirft
    ``ApiError``) und liefert das Größenlimit der Datei. ``sink_for`` wird
    erst nach erfolgreicher Options-Prüfung aufgerufen.
    """
    events = _Events()
    parser = MultipartParser(
        boundary,
        events.callbacks(),  # type: ignore[arg-type]
        max_header_size=MAX_PART_HEADER_BYTES,
    )
    part_index = 0
    part = _Part()
    options = bytearray()
    file_limit: int | None = None
    sink: FileSink | None = None
    upload: UploadedFile | None = None
    file_done = False

    async def bounded_chunks() -> AsyncIterator[bytes]:
        received = 0
        async for raw in stream:
            received += len(raw)
            if received > max_body_bytes:
                raise ApiError(ApiErrorCode.FILE_TOO_LARGE, 413, "Upload ist zu groß.")
            for offset in range(0, len(raw), PARSER_CHUNK_BYTES):
                yield raw[offset : offset + PARSER_CHUNK_BYTES]

    async for chunk in bounded_chunks():
        if not chunk:
            continue
        try:
            parser.write(chunk)
        except MultipartParseError as exc:
            raise invalid_request("Multipart-Daten fehlerhaft.", 400) from exc
        pending: list[bytes] = []
        for kind, data in events.items:
            match kind:
                case "begin":
                    part_index += 1
                    part = _Part()
                    if file_done:
                        # Vertrag: mehr als ein Dateiteil → missing-file.
                        raise ApiError(ApiErrorCode.MISSING_FILE, 422, "Genau eine Datei erwartet.")
                case "header":
                    part.header_bytes += len(data)
                    if part.header_bytes > MAX_PART_HEADER_BYTES:
                        raise invalid_request("Teil-Header zu groß.", 400)
                    name, _, value = data.partition(b"\x00")
                    part.headers.append((name, value))
                case "headers_done":
                    _disposition(part)
                    if part_index == 1 and (part.name != "options" or part.filename is not None):
                        raise invalid_request("Erster Teil muss options sein.")
                    if part_index == 2:
                        if part.name != "file" or part.filename is None:
                            raise ApiError(ApiErrorCode.MISSING_FILE, 422, "Dateiteil fehlt.")
                        upload = UploadedFile(original_name=part.filename)
                        sink = await sink_for()
                case "data" if part_index == 1:
                    options += data
                    if len(options) > OPTIONS_MAX_BYTES:
                        raise invalid_request("options ist zu groß.")
                case "data" if upload is not None and file_limit is not None:
                    upload.feed(data)
                    if upload.size > file_limit:
                        raise ApiError(
                            ApiErrorCode.FILE_TOO_LARGE,
                            413,
                            f"Datei überschreitet {file_limit} Bytes.",
                        )
                    pending.append(data)
                case "end" if part_index == 1:
                    file_limit = on_options(bytes(options))
                case "end" if part_index == 2:
                    file_done = True
                case _:
                    pass
        events.items.clear()
        if pending and sink is not None:
            await sink.write(b"".join(pending))

    if not events.ended:
        # Body endete vor der abschließenden Boundary (z. B. Abbruch).
        if part_index == 0:
            raise invalid_request("Multipart-Daten fehlerhaft.", 400)
        if part_index == 1 and file_limit is None:
            raise invalid_request("Multipart-Daten unvollständig.", 400)
        raise invalid_request("Multipart-Daten unvollständig.", 400)
    if file_limit is None:
        raise invalid_request("options fehlt.")
    if upload is None or not file_done:
        raise ApiError(ApiErrorCode.MISSING_FILE, 422, "Dateiteil fehlt.")
    return upload
