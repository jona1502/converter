"""Formaterkennung anhand der ersten Dateibytes (nicht Endung oder MIME-Typ).

Gleiche Regeln wie ``detectFormat`` in ``src/lib/image/sniff.ts`` bzw.
``sniff-formats.ts``; PDF nach Vertrag: ``%PDF-`` in den ersten 1024 Bytes.
Die Header-Probe (Abmessungen, Animation) folgt mit Pillow in B05.
"""

from __future__ import annotations

import struct
from typing import Final

from app.jobs.domain import InputFormat

# So viele Anfangsbytes hält der Upload für die Erkennung im Speicher.
SNIFF_BYTES: Final = 4096
PDF_SIGNATURE_WINDOW: Final = 1024

_PNG: Final = b"\x89PNG\r\n\x1a\n"
_BMP_HEADER_SIZES: Final = frozenset({12, 40, 52, 56, 64, 108, 124})


def _u16le(b: bytes, offset: int) -> int:
    value: int = struct.unpack_from("<H", b, offset)[0]
    return value


def _u32le(b: bytes, offset: int) -> int:
    value: int = struct.unpack_from("<I", b, offset)[0]
    return value


def _is_bmp(b: bytes) -> bool:
    # "BM" allein ist zu schwach; zusätzlich muss die DIB-Headergröße bekannt sein.
    return len(b) >= 18 and b[:2] == b"BM" and _u32le(b, 14) in _BMP_HEADER_SIZES


def _is_ico(b: bytes) -> bool:
    # reserved 0, type 1 (Symbol; Cursor = 2 nicht unterstützt), mindestens ein Eintrag.
    if len(b) < 6 or _u16le(b, 0) != 0 or _u16le(b, 2) != 1:
        return False
    count = _u16le(b, 4)
    if count < 1:
        return False
    if len(b) >= 6 + 16:
        size = _u32le(b, 6 + 8)
        offset = _u32le(b, 6 + 12)
        if size == 0 or offset < 6 + 16 * count:
            return False
    return True


def _is_avif(b: bytes) -> bool:
    if len(b) < 16 or b[4:8] != b"ftyp":
        return False
    size = struct.unpack_from(">I", b, 0)[0]
    if size < 16 or size > 4096:
        return False
    end = min(size, len(b))
    brands = [b[8:12]] + [b[o : o + 4] for o in range(16, end - 3, 4)]
    return b"avif" in brands or b"avis" in brands


def detect_image_format(head: bytes) -> InputFormat | None:
    if head[:3] == b"\xff\xd8\xff":
        return InputFormat.JPEG
    if head[:8] == _PNG:
        return InputFormat.PNG
    if len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return InputFormat.WEBP
    if head[:6] in {b"GIF87a", b"GIF89a"}:
        return InputFormat.GIF
    if _is_bmp(head):
        return InputFormat.BMP
    if _is_avif(head):
        return InputFormat.AVIF
    if _is_ico(head):
        return InputFormat.ICO
    return None


def is_pdf(head: bytes) -> bool:
    return b"%PDF-" in head[:PDF_SIGNATURE_WINDOW]
