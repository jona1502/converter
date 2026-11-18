"""Strenge Seitenbereichs-Syntax, identisch zu Go (``pagerange``) und TypeScript.

``liste = bereich *("," bereich)``, ``bereich = zahl ["-" [zahl]]``, Zahlen 1 bis
99999 ohne führende Nullen, nur ASCII, kein Leerraum. ``7-`` heißt: bis zur
letzten Seite (Ende ``None``). Die gemeinsamen Testvektoren liegen in
``api/page-range-vectors.json``.
"""

from __future__ import annotations

import re
from typing import Final

MAX_PAGE_NUMBER: Final = 99_999
MAX_RANGES: Final = 500
MAX_LENGTH: Final = 1024

# Ausdrücklich [0-9] statt \d: \d erlaubt auch andere Unicode-Ziffern.
_ITEM: Final = re.compile(r"([1-9][0-9]{0,4})(?:(-)([1-9][0-9]{0,4})?)?")

PageRange = tuple[int, int | None]


def parse_ranges(spec: str) -> tuple[PageRange, ...]:
    """Prüft die Angabe vollständig; ``ValueError`` bei jeder Verletzung."""
    if not spec or len(spec) > MAX_LENGTH:
        raise ValueError("page ranges: empty or too long")
    items = spec.split(",")
    if len(items) > MAX_RANGES:
        raise ValueError("page ranges: too many")
    result: list[PageRange] = []
    for item in items:
        match = _ITEM.fullmatch(item)
        if match is None:
            raise ValueError("page ranges: syntax")
        start = int(match.group(1))
        end: int | None
        if match.group(2) is None:
            end = start
        elif match.group(3) is None:
            end = None
        else:
            end = int(match.group(3))
            if end < start:
                raise ValueError("page ranges: descending")
        if start > MAX_PAGE_NUMBER or (end is not None and end > MAX_PAGE_NUMBER):
            raise ValueError("page ranges: page number too large")
        result.append((start, end))
    return tuple(result)
