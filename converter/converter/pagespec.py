"""Seitenauswahl für PDF zu Bild: ``all`` oder Liste wie ``1-3,5``.

Reine Python-Logik ohne native Parser (darf vor der Sandbox geladen werden).
Seiten zählen ab 1. Dieselben Regeln prüft Go vor der Annahme
(``server/internal/apitypes/pdfimage.go``); hier bleibt die Prüfung defensiv.
"""

from __future__ import annotations

import re
from typing import Final

MAX_TEXT: Final = 200
MAX_PAGE: Final = 9999
_TOKEN = re.compile(r"([0-9]{1,4})(?:-([0-9]{1,4}))?")


def parse_pages(text: str) -> tuple[int, ...] | None:
    """Liefert aufsteigende, eindeutige Seitennummern; ``None`` bedeutet alle Seiten."""
    if type(text) is not str or not text or len(text) > MAX_TEXT:
        raise ValueError("pages: invalid")
    if text == "all":
        return None
    pages: set[int] = set()
    for token in text.split(","):
        match = _TOKEN.fullmatch(token)
        if match is None:
            raise ValueError("pages: invalid")
        first = int(match.group(1))
        last = int(match.group(2) or first)
        if first < 1 or last < first or last > MAX_PAGE:
            raise ValueError("pages: out of range")
        pages.update(range(first, last + 1))
    return tuple(sorted(pages))


def normalize_pages(pages: tuple[int, ...]) -> str:
    """Kanonische Kurzschreibweise: Läufe als ``a-b``, sonst einzeln, ohne Leerzeichen."""
    parts: list[str] = []
    start = previous = pages[0]
    for page in (*pages[1:], None):
        if page is not None and page == previous + 1:
            previous = page
            continue
        parts.append(str(start) if start == previous else f"{start}-{previous}")
        if page is not None:
            start = previous = page
    return ",".join(parts)
