"""Optionen für ``pdf-rotate`` (Vertrag §4 „Optionen PDF drehen“).

Eigene Datei, damit ``options.py`` nur um eine Dispatch-Zeile wächst. Gleiche
Regeln wie Go (``parsePdfRotateOptions``): ``angle`` 90/180/270, ``pages`` ist
``all`` oder eine aufsteigend gemeinte Liste einzelner Seiten und Bereiche
(``1-3,5``). Ob die Seiten im Dokument existieren, prüft erst die Pipeline.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Final

from converter import validation as v

CODE: Final = "invalid-options"
PDF_ROTATE_TOOL: Final = "pdf-rotate"
ROTATE_ANGLES: Final = (90, 180, 270)
ROTATE_ALL: Final = "all"
MAX_PAGES_SPEC: Final = 256
# Zahl oder Bereich, durch Kommas getrennt; keine Leerzeichen, keine Vorzeichen.
_PAGES = re.compile(r"[1-9][0-9]{0,6}(-[1-9][0-9]{0,6})?(,[1-9][0-9]{0,6}(-[1-9][0-9]{0,6})?)*")


@dataclass(frozen=True, slots=True)
class PdfRotateOptions:
    angle: int
    pages: str = ROTATE_ALL
    tool: str = PDF_ROTATE_TOOL


def parse_page_ranges(spec: str) -> list[tuple[int, int]]:
    """Zerlegt ``1-3,5`` in ``[(1, 3), (5, 5)]``; ungültige Syntax: ``invalid-options``."""
    if _PAGES.fullmatch(spec) is None:
        raise v.fail(CODE, "pages: invalid range list")
    ranges: list[tuple[int, int]] = []
    for part in spec.split(","):
        first, _, last = part.partition("-")
        start, end = int(first), int(last or first)
        if start > end:
            raise v.fail(CODE, "pages: range reversed")
        ranges.append((start, end))
    return ranges


def parse_pdf_rotate(value: dict[str, object]) -> PdfRotateOptions:
    raw = v.obj(value, required=("tool", "angle"), optional=("pages",), code=CODE, where="options")
    angle = raw["angle"]
    if type(angle) is not int or angle not in ROTATE_ANGLES:
        raise v.fail(CODE, "angle: unknown")
    pages = ROTATE_ALL
    if "pages" in raw:
        pages = v.string(raw["pages"], code=CODE, where="pages", max_length=MAX_PAGES_SPEC)
        if pages != ROTATE_ALL:
            parse_page_ranges(pages)
    return PdfRotateOptions(angle=angle, pages=pages)
