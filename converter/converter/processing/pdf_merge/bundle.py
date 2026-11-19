"""Leser für das Bündelformat des Go-Uploads (Gegenstück: ``jobs/pdfmerge_bundle.go``).

Aufbau::

    b"MIPDFMRG1\n"
    je Datei: Blöcke [uint32 BE n > 0][n Bytes] ..., dann [uint32 0]
    Ende: eine Datei ohne Blöcke (zweimal hintereinander uint32 0)

Die Eingabe stammt aus einem Upload und ist nicht vertrauenswürdig: jede
Länge wird gegen die verbleibende Dateigröße und das Gesamtbudget geprüft,
bevor Speicher belegt wird.
"""

from __future__ import annotations

import struct
from pathlib import Path
from typing import BinaryIO, Final

from converter.errors import ProcessingError

MAGIC: Final = b"MIPDFMRG1\n"
MIN_FILES: Final = 2
MAX_FILES: Final = 20
SIGNATURE_WINDOW: Final = 1024


def _read(stream: BinaryIO, count: int) -> bytes:
    data = stream.read(count)
    if len(data) != count:
        raise ProcessingError("decode-failed", "Bundle truncated")
    return data


def read_bundle(source: Path, max_payload_bytes: int) -> list[bytes]:
    """Liefert die Dateien in Upload-Reihenfolge; Fehler als ``ProcessingError``."""
    try:
        size = source.stat().st_size
        stream = source.open("rb")
    except OSError as exc:
        raise ProcessingError("decode-failed", "Bundle unreadable") from exc
    files: list[bytes] = []
    total = 0
    with stream:
        if _read(stream, len(MAGIC)) != MAGIC:
            raise ProcessingError("decode-failed", "Bundle header missing")
        remaining = size - len(MAGIC)
        parts: list[bytes] = []
        while True:
            (length,) = struct.unpack(">I", _read(stream, 4))
            remaining -= 4
            if length == 0:
                if not parts:
                    break
                files.append(b"".join(parts))
                parts = []
                if len(files) > MAX_FILES:
                    raise ProcessingError("decode-failed", "Too many files")
                continue
            if length > remaining:
                raise ProcessingError("decode-failed", "Bundle truncated")
            total += length
            if total > max_payload_bytes:
                raise ProcessingError("file-too-large", "PDFs exceed input limit")
            parts.append(_read(stream, length))
            remaining -= length
        if stream.read(1):
            raise ProcessingError("decode-failed", "Data after bundle end")
    if len(files) < MIN_FILES:
        raise ProcessingError("decode-failed", "Too few files")
    for data in files:
        if b"%PDF-" not in data[:SIGNATURE_WINDOW]:
            raise ProcessingError("not-pdf", "PDF signature missing")
    return files
