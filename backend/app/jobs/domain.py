"""Fachliche Begriffe (Vertrag §1, §5): Werkzeuge, Zustände, Formate.

Eine Stelle für alle festen Wertemengen. Datenbank-Constraints, Pydantic-
Schemas und OpenAPI leiten sich hiervon ab.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Final


class Tool(StrEnum):
    IMAGE_CONVERT = "image-convert"
    IMAGE_COMPRESS = "image-compress"
    IMAGE_RESIZE = "image-resize"
    PDF_COMPRESS = "pdf-compress"

    @property
    def is_image(self) -> bool:
        return self is not Tool.PDF_COMPRESS


class JobState(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    PARTIALLY_SUCCEEDED = "partially_succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"
    EXPIRED = "expired"


ACTIVE_JOB_STATES: Final = frozenset({JobState.QUEUED, JobState.RUNNING})


class JobPhase(StrEnum):
    ANALYZE = "analyze"
    VARIANT = "variant"
    ENCODE = "encode"
    SAVE = "save"


class ResultState(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class PdfLevel(StrEnum):
    HIGH = "high"
    BALANCED = "balanced"
    SMALL = "small"


class InputFormat(StrEnum):
    """Anhand der Bytes erkanntes Eingabeformat."""

    JPEG = "jpeg"
    PNG = "png"
    WEBP = "webp"
    GIF = "gif"
    BMP = "bmp"
    ICO = "ico"
    AVIF = "avif"
    PDF = "pdf"


class OutputFormat(StrEnum):
    JPEG = "jpeg"
    PNG = "png"
    WEBP = "webp"
    BMP = "bmp"
    ICO = "ico"


IMAGE_INPUT_FORMATS: Final = frozenset(InputFormat) - {InputFormat.PDF}

# Endung und MIME je Ausgabeformat (wie FORMAT_INFO in src/lib/image/types.ts).
OUTPUT_EXTENSIONS: Final = {
    OutputFormat.JPEG: "jpg",
    OutputFormat.PNG: "png",
    OutputFormat.WEBP: "webp",
    OutputFormat.BMP: "bmp",
    OutputFormat.ICO: "ico",
}
OUTPUT_MIME: Final = {
    OutputFormat.JPEG: "image/jpeg",
    OutputFormat.PNG: "image/png",
    OutputFormat.WEBP: "image/webp",
    OutputFormat.BMP: "image/bmp",
    OutputFormat.ICO: "image/x-icon",
}
PDF_MIME: Final = "application/pdf"


class OutboxKind(StrEnum):
    DISPATCH = "dispatch"
    DELETE = "delete"
