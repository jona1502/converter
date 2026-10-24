"""Auftragsoptionen (Vertrag §4 „Optionen Bild“ / „Optionen PDF“).

Streng: unbekannte Felder sind Fehler, Typen werden nicht umgewandelt
(``"0.5"`` ist keine Zahl), ``snake_case``-Namen werden nicht akzeptiert.
Regeln, die mehrere Felder betreffen, prüfen die ``model_validator``.
"""

from __future__ import annotations

import json
from typing import Annotated, Any, Final, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, model_validator
from pydantic_core import PydanticCustomError

from app.jobs.domain import OutputFormat, PdfLevel, Tool

IcoSize = Literal[16, 32, 48, 64, 128, 256]
DEFAULT_ICO_SIZES: Final[list[IcoSize]] = [16, 32, 48, 256]
DEFAULT_PDF_LEVELS: Final = [PdfLevel.HIGH, PdfLevel.BALANCED, PdfLevel.SMALL]

PositivePixels = Annotated[int, Field(gt=0)]


class _Options(BaseModel):
    model_config = ConfigDict(
        validate_by_alias=True,
        validate_by_name=False,
        serialize_by_alias=True,
        extra="forbid",
        strict=True,
        frozen=True,
    )


def _invalid(code: str, message: str) -> PydanticCustomError:
    # Eigene Fehlerart, damit die API sie als invalid-options meldet.
    return PydanticCustomError(code, message)


class ResizeNone(_Options):
    mode: Literal["none"]


class ResizePercent(_Options):
    mode: Literal["percent"]
    percent: float = Field(gt=0, allow_inf_nan=False)
    allow_upscale: bool = Field(alias="allowUpscale")

    @model_validator(mode="after")
    def _upscale(self) -> Self:
        if self.percent > 100 and not self.allow_upscale:
            raise _invalid("upscale-not-allowed", "percent > 100 erfordert allowUpscale")
        return self


class ResizeDimensions(_Options):
    mode: Literal["dimensions"]
    width: PositivePixels | None = None
    height: PositivePixels | None = None
    keep_aspect_ratio: bool = Field(alias="keepAspectRatio")
    allow_upscale: bool = Field(alias="allowUpscale")

    @model_validator(mode="after")
    def _sizes(self) -> Self:
        if self.keep_aspect_ratio and self.width is None and self.height is None:
            raise _invalid("dimension-required", "width oder height erforderlich")
        if not self.keep_aspect_ratio and (self.width is None or self.height is None):
            raise _invalid("dimensions-required", "width und height erforderlich")
        return self


class ResizeMaxEdge(_Options):
    mode: Literal["maxEdge"]
    max_edge: PositivePixels = Field(alias="maxEdge")


ResizeOptions = Annotated[
    ResizeNone | ResizePercent | ResizeDimensions | ResizeMaxEdge,
    Field(discriminator="mode"),
]

ImageFormatOption = Literal["jpeg", "png", "webp", "bmp", "ico", "original"]


class ImageOptions(_Options):
    tool: Literal[Tool.IMAGE_CONVERT, Tool.IMAGE_COMPRESS, Tool.IMAGE_RESIZE]
    format: ImageFormatOption
    quality: float = Field(default=0.85, ge=0, le=1, allow_inf_nan=False)
    background: str = Field(default="#ffffff", pattern=r"^#[0-9a-fA-F]{6}$")
    resize: ResizeOptions = Field(default_factory=lambda: ResizeNone(mode="none"))
    # None = Standardgrößen, falls das Ergebnis ICO ist.
    ico_sizes: list[IcoSize] | None = Field(default=None, min_length=1, alias="icoSizes")

    @model_validator(mode="after")
    def _ico_rules(self) -> Self:
        if self.ico_sizes is not None:
            if self.format not in {"ico", "original"}:
                raise _invalid("ico-sizes-without-ico", "icoSizes nur bei format ico")
            if len(set(self.ico_sizes)) != len(self.ico_sizes):
                raise _invalid("duplicate-values", "icoSizes ohne Duplikate")
        if self.format == "ico" and self.resize.mode != "none":
            raise _invalid("ico-resize", "bei ico ist nur resize.mode none erlaubt")
        return self

    def output_format(self, input_format: str) -> OutputFormat | None:
        """Tatsächliches Zielformat; None, wenn ``original`` nicht erzeugbar ist."""
        target = input_format if self.format == "original" else self.format
        try:
            return OutputFormat(target)
        except ValueError:
            return None

    def effective_ico_sizes(self) -> list[IcoSize]:
        return list(self.ico_sizes) if self.ico_sizes is not None else list(DEFAULT_ICO_SIZES)


class PdfOptions(_Options):
    tool: Literal[Tool.PDF_COMPRESS]
    levels: list[PdfLevel] = Field(default_factory=lambda: list(DEFAULT_PDF_LEVELS), min_length=1)

    @model_validator(mode="after")
    def _unique(self) -> Self:
        if len(set(self.levels)) != len(self.levels):
            raise _invalid("duplicate-values", "levels ohne Duplikate")
        return self


JobOptions = Annotated[ImageOptions | PdfOptions, Field(discriminator="tool")]
JOB_OPTIONS_ADAPTER: Final[TypeAdapter[ImageOptions | PdfOptions]] = TypeAdapter(JobOptions)


def canonical_options(options: ImageOptions | PdfOptions) -> dict[str, Any]:
    """Optionen mit angewendeten Standardwerten – Grundlage des Fingerabdrucks."""
    dumped: dict[str, Any] = options.model_dump(mode="json", by_alias=True)
    return dumped


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    ).encode()
