"""PDF drehen: setzt ``/Rotate`` der gewählten Seiten, ohne Inhalt zu verändern.

Es wird nichts gerastert und kein Seiteninhalt angefasst; die Drehung wirkt
relativ zu einem bereits gesetzten (auch geerbten) ``/Rotate``. Verschlüsselte
PDFs, fehlende Signatur, Größen- und Seitengrenzen verhalten sich wie bei der
Komprimierung (gleiche ``open_source``-Prüfung).
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, BinaryIO, cast

import pikepdf

from converter.errors import ProcessingError
from converter.limits import Limits
from converter.processing.files import open_result
from converter.processing.pdf.pipeline import LimitedWriter, open_source
from converter.rotate_options import ROTATE_ALL, PdfRotateOptions, parse_page_ranges


def selected_pages(pages: str, page_count: int) -> list[int]:
    """Nullbasierte, aufsteigende, eindeutige Indizes; Seite hinter dem Ende: invalid-options."""
    if pages == ROTATE_ALL:
        return list(range(page_count))
    chosen: set[int] = set()
    for start, end in parse_page_ranges(pages):
        if end > page_count:
            raise ProcessingError("invalid-options", "Page range exceeds page count")
        chosen.update(range(start - 1, end))
    return sorted(chosen)


def rotate(
    source: Path,
    target: Path,
    options: PdfRotateOptions,
    limits: Limits,
    output_limit: int | None = None,
) -> dict[str, Any]:
    limit = limits.pdf_max_results_total_bytes if output_limit is None else output_limit
    try:
        with open_source(source, limits) as pdf:
            count = len(pdf.pages)
            if count < 1:
                raise ProcessingError("parse-failed", "PDF without pages")
            indices = selected_pages(options.pages, count)
            for index in indices:
                pdf.pages[index].rotate(options.angle, relative=True)
            with os.fdopen(open_result(target), "wb") as stream:
                pdf.save(cast(BinaryIO, LimitedWriter(stream, limit)))
    except (pikepdf.PdfError, ValueError, TypeError, OverflowError) as exc:
        raise ProcessingError("parse-failed", "PDF rotation failed") from exc
    return {"pageCount": count, "rotatedPages": len(indices)}
