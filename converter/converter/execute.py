"""Auftragsablauf im isolierten Prozess; importiert native Parser.

Nur nach ``sandbox.isolate`` importieren (siehe ``cli``). Verhalten wie
``backend/app/worker/child.py``: Bild = ein Ergebnis; PDF = Analyse, danach
jede Stufe aus dem Original, Teilfehler betreffen nur die jeweilige Stufe.
Audio = ein Ergebnis wie bei Bildern.
"""

from __future__ import annotations

import time
from pathlib import Path

from converter.errors import ProcessingError
from converter.options import AudioOptions, ImageOptions, MarkdownOptions, PdfOptions
from converter.processing.audio import pipeline as audio
from converter.processing.files import discard
from converter.processing.images.pipeline import convert
from converter.processing.markdown import pipeline as markdown
from converter.processing.pdf.pipeline import analyze, compress
from converter.protocol import EventWriter, Request, ResultTarget

# Fortschritt höchstens alle 0,25 s je Stufe (plus erstes und letztes Ereignis),
# damit PDFs mit Tausenden Bildern die Ereignisgrenzen von Go nicht fluten.
PROGRESS_INTERVAL = 0.25


def _failure(writer: EventWriter, target: ResultTarget, exc: Exception, fallback: str) -> None:
    discard(Path(target.path))
    if isinstance(exc, ProcessingError):
        writer.error(target.id, exc.code, fallback)
    elif isinstance(exc, MemoryError):
        writer.error(target.id, "memory-limit", fallback)
    else:
        writer.error(target.id, fallback, fallback)


def run_image(request: Request, options: ImageOptions, writer: EventWriter) -> None:
    (target,) = request.results
    writer.progress_encode()
    try:
        details = convert(Path(request.source), Path(target.path), options, request.limits)
    except Exception as exc:
        _failure(writer, target, exc, "encode-failed")
        return
    writer.result(target.id, details)


def run_audio(request: Request, options: AudioOptions, writer: EventWriter) -> None:
    (target,) = request.results
    writer.progress_encode()
    try:
        details = audio.convert(Path(request.source), Path(target.path), options, request.limits)
    except Exception as exc:
        _failure(writer, target, exc, "encode-failed")
        return
    writer.result(target.id, details)


def run_pdf(request: Request, options: PdfOptions, writer: EventWriter) -> None:
    source = Path(request.source)
    limits = request.limits
    # Analysefehler (verschlüsselt, beschädigt, Grenze) beenden den Auftrag: fatal.
    writer.analysis(analyze(source, limits))
    used = 0
    for target in request.results:
        level = target.level or ""
        last = 0.0

        def progress(current: int, total: int, level: str = level) -> None:
            nonlocal last
            now = time.monotonic()
            if current in {0, total} or now - last >= PROGRESS_INTERVAL:
                last = now
                writer.progress_variant(level, current, total)

        path = Path(target.path)
        try:
            remaining = limits.pdf_max_results_total_bytes - used
            if remaining <= 0:
                raise ProcessingError("result-too-large")
            details = compress(source, path, level, limits, progress, output_limit=remaining)
            size = path.stat().st_size
            if size > remaining:
                raise ProcessingError("result-too-large")
        except Exception as exc:
            _failure(writer, target, exc, "parse-failed")
            continue
        used += size
        writer.result(target.id, details)


def execute(request: Request, writer: EventWriter) -> None:
    options = request.options
    if isinstance(options, ImageOptions):
        run_image(request, options, writer)
    elif isinstance(options, AudioOptions):
        run_audio(request, options, writer)
    elif isinstance(options, MarkdownOptions):
        (target,) = request.results
        writer.progress_encode()
        try:
            details = markdown.convert(
                Path(request.source), Path(target.path), request.limits, options
            )
        except Exception as exc:
            _failure(writer, target, exc, "encode-failed")
            return
        writer.result(target.id, details)
    else:
        run_pdf(request, options, writer)
