"""Verlustfreies Zusammenführen mehrerer PDFs in Upload-Reihenfolge.

Seiten werden unverändert aus den Quellen übernommen (pikepdf/qpdf kopiert
die Seitenobjekte samt Ressourcen). Nicht übernommen werden dokumentweite
Strukturen der Quellen wie Lesezeichen, Formularfelder und Metadaten.
Verschlüsselte oder nur durch Reparatur lesbare PDFs werden abgelehnt.
"""

from __future__ import annotations

import contextlib
import io
import os
from pathlib import Path
from typing import Final

import pikepdf
from pikepdf import Pdf

from converter.errors import ProcessingError
from converter.limits import Limits
from converter.processing.files import discard, open_result
from converter.processing.pdf_merge.bundle import read_bundle

MAX_PAGES: Final = 2000


def _open(data: bytes) -> Pdf:
    try:
        pdf = Pdf.open(io.BytesIO(data), attempt_recovery=False)
    except pikepdf.PasswordError as exc:
        raise ProcessingError("encrypted", "Encrypted PDF") from exc
    except (pikepdf.PdfError, ValueError) as exc:
        raise ProcessingError("parse-failed", "Invalid PDF") from exc
    if pdf.is_encrypted:
        pdf.close()
        raise ProcessingError("encrypted", "Encrypted PDF")
    return pdf


def merge(source: Path, destination: Path, limits: Limits) -> dict[str, object]:
    """Schreibt genau ein PDF in die vorhandene Ergebnisdatei."""
    try:
        files = read_bundle(source, limits.pdf_max_input_bytes)
        pages = 0
        with contextlib.ExitStack() as stack:
            merged = stack.enter_context(Pdf.new())
            for data in files:
                part = stack.enter_context(contextlib.closing(_open(data)))
                pages += len(part.pages)
                if pages > MAX_PAGES:
                    raise ProcessingError("dimensions-too-large", "Too many pages")
                try:
                    merged.pages.extend(part.pages)
                except (pikepdf.PdfError, ValueError) as exc:
                    raise ProcessingError("parse-failed", "Pages not copyable") from exc
            if pages < 1:
                raise ProcessingError("parse-failed", "No pages")
            try:
                with os.fdopen(open_result(destination), "wb") as output:
                    merged.save(output)
                size = destination.stat().st_size
            except (OSError, pikepdf.PdfError, ValueError) as exc:
                raise ProcessingError("save-failed", "Saving failed") from exc
        if size > limits.pdf_max_input_bytes:
            raise ProcessingError("result-too-large", "Merged PDF exceeds limit")
        return {"pageCount": pages, "sourceCount": len(files)}
    except Exception:
        discard(destination)
        raise
