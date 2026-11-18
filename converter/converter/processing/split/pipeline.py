"""Eine PDF in Teil-PDFs aufteilen; mehrere Teile werden als ZIP verpackt.

Je Bereich (oder je Seite) entsteht ein eigenes Dokument, in das nur die
gewählten Seiten samt der von ihnen erreichbaren Objekte kopiert werden.
Dokumentweite Strukturen (Lesezeichen, Formularfelder, Anhänge) gehören zu
keiner einzelnen Seite und werden nicht übernommen. Verschlüsselte PDFs
werden abgelehnt (``encrypted``). Ein einziger Bereich ergibt direkt eine PDF,
alles andere ein ZIP ohne Verzeichnisse mit festen, ASCII-Dateinamen.
"""

from __future__ import annotations

import io
import os
import zipfile
from pathlib import Path
from typing import Any

import pikepdf
from pikepdf import Pdf

from converter.errors import ProcessingError
from converter.limits import Limits
from converter.options import SplitOptions
from converter.processing.files import open_result
from converter.processing.pdf.pipeline import open_source
from converter.processing.split.ranges import MAX_RANGES

# Mit "each" begrenzt dieselbe Zahl die Teile wie bei Bereichen.
MAX_PARTS = MAX_RANGES


def resolve(options: SplitOptions, total: int) -> list[tuple[int, int]]:
    """Konkrete 1-basierte Seitenbereiche; ``page-range-invalid`` außerhalb des Dokuments."""
    if options.mode == "each":
        return [(page, page) for page in range(1, total + 1)]
    spans: list[tuple[int, int]] = []
    for start, end in options.ranges:
        last = total if end is None else end
        if start > total or last > total:
            raise ProcessingError("page-range-invalid", "Range outside the document")
        spans.append((start, last))
    return spans


def _name(index: int, count: int, span: tuple[int, int], each: bool) -> str:
    """Eindeutiger ASCII-Name; die Nummer sorgt für Eindeutigkeit und Sortierung."""
    width = max(2, len(str(count)))
    start, end = span
    if each:
        return f"seite-{start:0{width}d}.pdf"
    pages = f"seite-{start}" if start == end else f"seiten-{start}-{end}"
    return f"teil-{index:0{width}d}-{pages}.pdf"


def _part(pdf: Pdf, span: tuple[int, int]) -> bytes:
    start, end = span
    with Pdf.new() as part:
        part.pages.extend(pdf.pages[start - 1 : end])
        buffer = io.BytesIO()
        part.save(buffer)
        return buffer.getvalue()


def convert(
    source: Path, destination: Path, options: SplitOptions, limits: Limits
) -> dict[str, Any]:
    """Schreibt eine PDF oder ein ZIP nach ``destination``; Details: Seiten- und Teilezahl."""
    try:
        with open_source(source, limits) as pdf:
            total = len(pdf.pages)
            if total < 1:
                raise ProcessingError("parse-failed", "PDF without pages")
            spans = resolve(options, total)
            if not 1 <= len(spans) <= MAX_PARTS:
                raise ProcessingError("page-range-invalid", "Too many parts")
            budget = limits.pdf_max_results_total_bytes
            with os.fdopen(open_result(destination), "wb") as handle:
                if options.single_pdf:
                    data = _part(pdf, spans[0])
                    if len(data) > budget:
                        raise ProcessingError("result-too-large", "Result exceeds limit")
                    handle.write(data)
                else:
                    used = 0
                    each = options.mode == "each"
                    with zipfile.ZipFile(handle, "w", zipfile.ZIP_STORED) as archive:
                        for index, span in enumerate(spans, start=1):
                            data = _part(pdf, span)
                            used += len(data)
                            if used > budget:
                                raise ProcessingError("result-too-large", "Result exceeds limit")
                            archive.writestr(_name(index, len(spans), span, each), data)
    except ProcessingError:
        raise
    except MemoryError:
        raise
    except (pikepdf.PdfError, ValueError, OSError, zipfile.BadZipFile) as exc:
        raise ProcessingError("parse-failed", "PDF could not be split") from exc
    return {"pageCount": total, "partCount": len(spans)}
