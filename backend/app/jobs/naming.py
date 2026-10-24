"""Anzeige- und Downloadnamen (Vertrag §4 und §5 „Downloadnamen“).

Bereinigung wie ``src/lib/image/filename.ts``: Steuer- und Bidi-Zeichen
entfernen, Pfadtrenner und unter Windows unzulässige Zeichen durch ``_``
ersetzen, Leerraum zusammenfassen, führende/abschließende Punkte und
Leerzeichen entfernen, Stamm auf 100 Zeichen kürzen, reservierte
Windows-Namen mit ``_`` versehen. Namen dienen nur der Anzeige und dem
``Content-Disposition``-Header – nie einem Dateipfad.
"""

from __future__ import annotations

import re
from typing import Final

from app.jobs.domain import OUTPUT_EXTENSIONS, InputFormat, OutputFormat, PdfLevel, Tool

MAX_BASE_LENGTH: Final = 100
IMAGE_FALLBACK_BASE: Final = "bild"
PDF_FALLBACK_BASE: Final = "dokument"

_CONTROL = re.compile(r"[\u0000-\u001f\u007f-\u009f]")
_BIDI = re.compile(r"[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]")
_FORBIDDEN = re.compile(r'[/\\:*?"<>|]')
_SPACE = re.compile(r"\s+")
_EDGES = re.compile(r"^[\s.]+|[\s.]+$")
_TRAILING = re.compile(r"[\s.]+$")
_RESERVED = re.compile(r"(con|prn|aux|nul|com[1-9]|lpt[1-9])", re.IGNORECASE)


def sanitize(part: str) -> str:
    part = _CONTROL.sub("", part)
    part = _BIDI.sub("", part)
    part = _FORBIDDEN.sub("_", part)
    part = _SPACE.sub(" ", part)
    return _EDGES.sub("", part)


def _truncate(value: str, limit: int) -> str:
    # Python-Strings zählen Codepoints; Ersatzpaare gibt es hier nicht.
    return value if len(value) <= limit else _TRAILING.sub("", value[:limit])


def _strip_extension(name: str) -> str:
    dot = name.rfind(".")
    return name[:dot] if dot > 0 else name


def _avoid_reserved(base: str) -> str:
    return f"_{base}" if _RESERVED.fullmatch(base) else base


def clean_base(original_name: str, fallback: str) -> str:
    base = _truncate(sanitize(_strip_extension(original_name)), MAX_BASE_LENGTH)
    return _avoid_reserved(base or fallback)


def display_name(original_name: str, fallback: str) -> str:
    """Bereinigter Originalname mit Endung, nur zur Anzeige gespeichert."""
    base = clean_base(original_name, fallback)
    dot = original_name.rfind(".")
    extension = _truncate(sanitize(original_name[dot + 1 :]), 16) if dot > 0 else ""
    return f"{base}.{extension}" if extension else base


def image_download_name(
    original_name: str, tool: Tool, input_format: InputFormat, output_format: OutputFormat
) -> str:
    match tool:
        case Tool.IMAGE_COMPRESS:
            suffix = "komprimiert"
        case Tool.IMAGE_RESIZE:
            suffix = "skaliert"
        case _:
            # Konverter: Suffix nur, wenn sich das Format nicht ändert.
            suffix = "konvertiert" if input_format.value == output_format.value else ""
    base = clean_base(original_name, IMAGE_FALLBACK_BASE)
    return f"{base}{'-' + suffix if suffix else ''}.{OUTPUT_EXTENSIONS[output_format]}"


def pdf_download_name(original_name: str, level: PdfLevel) -> str:
    return f"{clean_base(original_name, PDF_FALLBACK_BASE)}-{level.value}.pdf"
