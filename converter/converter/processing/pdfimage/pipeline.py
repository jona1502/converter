"""PDF zu Bild: rastert ausgewählte Seiten mit PDFium (pypdfium2).

Läuft nur im isolierten Konverterprozess nach ``sandbox.isolate``. Ablauf:
Eingabe und Verschlüsselung wie bei den übrigen PDF-Werkzeugen mit pikepdf
prüfen, Seitenauswahl und alle Zielgrößen vor dem ersten Rendern prüfen (kein
Rechenaufwand für Aufträge, die ohnehin scheitern), dann Seite für Seite
rendern, kodieren und sofort wieder freigeben. Genau eine ausdrücklich
gewählte Seite ergibt ein Bild, jede andere Auswahl ein ZIP.

Alle Fehler tragen nur Vertragscodes, nie Pfade oder Bibliothekstexte.
"""

from __future__ import annotations

import contextlib
import io
import math
import zipfile
from collections.abc import Callable
from pathlib import Path
from typing import Any, Final

import pypdfium2 as pdfium  # type: ignore[import-untyped]
import pypdfium2.raw as pdfium_raw  # type: ignore[import-untyped]
from PIL import Image

from converter.errors import ProcessingError
from converter.limits import Limits
from converter.options import PdfImageOptions
from converter.processing.files import open_result
from converter.processing.images.pipeline import save_options
from converter.processing.pdf.pipeline import open_source

# WebP erlaubt höchstens 16 383 Pixel je Kante; gleiche Grenze für alle Formate.
MAX_EDGE: Final = 16_383
EXTENSIONS: Final = {"png": "png", "jpeg": "jpg", "webp": "webp"}
# Fester Zeitstempel: gleiche Eingabe liefert byteidentische Archive.
ZIP_TIME: Final = (1980, 1, 1, 0, 0, 0)
Progress = Callable[[int, int], None]


class _BoundedWriter(io.BufferedWriter):
    """Ergebnisdatei mit Obergrenze; sie ist von Go vorab leer angelegt."""

    def __init__(self, path: Path, limit: int) -> None:
        super().__init__(io.FileIO(open_result(path), "w"))
        self.limit = limit

    def write(self, data: Any) -> int:
        if self.tell() + len(data) > self.limit:
            raise ProcessingError("result-too-large")
        return super().write(data)


def pixel_size(width_pt: float, height_pt: float, dpi: int) -> tuple[int, int]:
    """Zielgröße wie PDFium sie berechnet (aufgerundet)."""
    scale = dpi / 72
    return math.ceil(width_pt * scale), math.ceil(height_pt * scale)


def _selection(options: PdfImageOptions, count: int, limits: Limits) -> list[int]:
    if options.pages is None:
        pages = list(range(1, count + 1))
    else:
        if options.pages[-1] > count:
            raise ProcessingError("parse-failed", "Page selection outside of the document")
        pages = list(options.pages)
    if not pages:
        raise ProcessingError("parse-failed", "Document has no pages")
    if len(pages) > limits.pdf_render_max_pages:
        raise ProcessingError("result-too-large", "Too many pages")
    return pages


def _check_sizes(document: Any, pages: list[int], dpi: int, limits: Limits) -> None:
    for number in pages:
        page = document[number - 1]
        try:
            width, height = page.get_size()
        finally:
            page.close()
        if not (math.isfinite(width) and math.isfinite(height)) or width <= 0 or height <= 0:
            raise ProcessingError("parse-failed", "Invalid page size")
        pixels_w, pixels_h = pixel_size(width, height, dpi)
        if (
            pixels_w > MAX_EDGE
            or pixels_h > MAX_EDGE
            or pixels_w * pixels_h > limits.pdf_image_max_pixels
        ):
            raise ProcessingError("dimensions-too-large", "Rendered page is too large")


def _encode(image: Image.Image, options: PdfImageOptions) -> bytes:
    buffer = io.BytesIO()
    params = save_options(options.format, options.quality, [])
    if options.format in {"png", "jpeg"}:
        params["dpi"] = (options.dpi, options.dpi)
    image.save(buffer, format=options.format.upper(), **params)
    return buffer.getvalue()


def _render(document: Any, number: int, options: PdfImageOptions) -> bytes:
    page = document[number - 1]
    try:
        # Keine Formulare initialisieren: nur die sichtbare Seite wird gerastert.
        bitmap = page.render(scale=options.dpi / 72, rev_byteorder=True, may_draw_forms=False)
        try:
            image = bitmap.to_pil().convert("RGB")
        finally:
            bitmap.close()
        try:
            return _encode(image, options)
        finally:
            image.close()
    finally:
        page.close()


def _open_document(source: Path) -> Any:
    try:
        return pdfium.PdfDocument(str(source))
    except pdfium.PdfiumError as exc:
        # Passwortfehler (FPDF_ERR_PASSWORD) kann nach pikepdf kaum noch auftreten.
        code = (
            "encrypted"
            if getattr(exc, "err_code", None) == pdfium_raw.FPDF_ERR_PASSWORD
            else "parse-failed"
        )
        raise ProcessingError(code, "PDFium could not open the document") from exc


def convert(
    source: Path,
    destination: Path,
    options: PdfImageOptions,
    limits: Limits,
    progress: Progress,
) -> dict[str, Any]:
    # Signatur, Größe, Verschlüsselung und Struktur wie bei der Komprimierung.
    with open_source(source, limits):
        pass
    document = _open_document(source)
    try:
        count = len(document)
        pages = _selection(options, count, limits)
        _check_sizes(document, pages, options.dpi, limits)
        archive = not (options.pages is not None and len(pages) == 1)
        total = len(pages)
        progress(0, total)
        try:
            with _BoundedWriter(destination, limits.pdf_max_results_total_bytes) as out:
                if archive:
                    width = max(3, len(str(pages[-1])))
                    extension = EXTENSIONS[options.format]
                    with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as bundle:
                        for done, number in enumerate(pages, start=1):
                            info = zipfile.ZipInfo(
                                f"seite-{number:0{width}d}.{extension}", ZIP_TIME
                            )
                            info.external_attr = 0o600 << 16
                            bundle.writestr(info, _render(document, number, options))
                            progress(done, total)
                else:
                    out.write(_render(document, pages[0], options))
                    progress(1, total)
        except ProcessingError:
            raise
        except pdfium.PdfiumError as exc:
            raise ProcessingError("parse-failed", "PDFium could not render the page") from exc
    finally:
        with contextlib.suppress(Exception):
            document.close()
    return {"pageCount": total, "sourcePageCount": count, "archive": archive}
