"""Auftragsoptionen (Vertrag §4 „Optionen Bild“ / „Optionen PDF“ / „Optionen Audio“).

Gleiche Regeln wie ``backend/app/schemas/options.py``, aber als kleine
dataclasses ohne pydantic: unbekannte Felder, falsche Typen, nicht endliche
Zahlen, Duplikate und ungültige Kombinationen sind Fehler. Go validiert
vorher; der Konverter prüft defensiv erneut (Fehlercode ``invalid-options``).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Final, Literal

from converter import validation as v

CODE: Final = "invalid-options"

IMAGE_TOOLS: Final = ("image-convert", "image-compress", "image-resize")
PDF_TOOL: Final = "pdf-compress"
OUTPUT_FORMATS: Final = ("jpeg", "png", "webp", "bmp", "ico")
FORMAT_OPTIONS: Final = (*OUTPUT_FORMATS, "original")
ICO_SIZES: Final = (16, 32, 48, 64, 128, 256)
DEFAULT_ICO_SIZES: Final = (16, 32, 48, 256)
PDF_LEVELS: Final = ("high", "balanced", "small")
AUDIO_TOOL: Final = "audio-convert"
AUDIO_FORMATS: Final = ("mp3", "wav", "flac", "ogg")
# Nur bei diesen Zielformaten wirkt quality (libsndfile compression_level).
AUDIO_QUALITY_FORMATS: Final = ("mp3", "ogg")
AUDIO_CHANNELS: Final = ("original", "mono")
MARKDOWN_TOOL: Final = "markdown-pdf"
PDF_MERGE_TOOL: Final = "pdf-merge"
MARKDOWN_PAGE_SIZES: Final = ("a4", "letter")
MARKDOWN_ORIENTATIONS: Final = ("portrait", "landscape")
# 0,8 entspricht etwa LAME V2 bzw. Vorbis q8: transparent, aber kleiner als WAV.
DEFAULT_AUDIO_QUALITY: Final = 0.8
DEFAULT_QUALITY: Final = 0.85
DEFAULT_BACKGROUND: Final = "#ffffff"
# Obergrenze nur gegen absurde Werte; die fachliche Grenze prüft die Pipeline.
_MAX_PIXELS_OPTION: Final = 2**31 - 1
_BACKGROUND = re.compile(r"#[0-9a-fA-F]{6}")


@dataclass(frozen=True, slots=True)
class ResizeNone:
    mode: Literal["none"] = "none"


@dataclass(frozen=True, slots=True)
class ResizePercent:
    percent: float
    allow_upscale: bool
    mode: Literal["percent"] = "percent"


@dataclass(frozen=True, slots=True)
class ResizeDimensions:
    width: int | None
    height: int | None
    keep_aspect_ratio: bool
    allow_upscale: bool
    mode: Literal["dimensions"] = "dimensions"


@dataclass(frozen=True, slots=True)
class ResizeMaxEdge:
    max_edge: int
    mode: Literal["maxEdge"] = "maxEdge"


ResizeOptions = ResizeNone | ResizePercent | ResizeDimensions | ResizeMaxEdge


@dataclass(frozen=True, slots=True)
class ImageOptions:
    tool: str
    format: str
    quality: float = DEFAULT_QUALITY
    background: str = DEFAULT_BACKGROUND
    resize: ResizeOptions = ResizeNone()
    # None = Standardgrößen, falls das Ergebnis ICO ist.
    ico_sizes: tuple[int, ...] | None = None

    def output_format(self, input_format: str) -> str | None:
        """Tatsächliches Zielformat; None, wenn ``original`` nicht erzeugbar ist."""
        target = input_format if self.format == "original" else self.format
        return target if target in OUTPUT_FORMATS else None

    def effective_ico_sizes(self) -> list[int]:
        return list(self.ico_sizes if self.ico_sizes is not None else DEFAULT_ICO_SIZES)


@dataclass(frozen=True, slots=True)
class PdfOptions:
    levels: tuple[str, ...] = PDF_LEVELS
    tool: str = PDF_TOOL


@dataclass(frozen=True, slots=True)
class AudioOptions:
    format: str
    quality: float = DEFAULT_AUDIO_QUALITY
    channels: str = "original"
    tool: str = AUDIO_TOOL


@dataclass(frozen=True, slots=True)
class MarkdownOptions:
    tool: str = MARKDOWN_TOOL
    page_size: str = "a4"
    orientation: str = "portrait"


@dataclass(frozen=True, slots=True)
class PdfMergeOptions:
    tool: str = PDF_MERGE_TOOL


JobOptions = ImageOptions | PdfOptions | AudioOptions | MarkdownOptions | PdfMergeOptions


def _pixels(value: object, where: str) -> int:
    return v.integer(value, code=CODE, where=where, minimum=1, maximum=_MAX_PIXELS_OPTION)


def parse_resize(value: object) -> ResizeOptions:
    if type(value) is not dict or "mode" not in value:
        raise v.fail(CODE, "resize: object with mode expected")
    mode = value["mode"]
    if mode == "none":
        v.obj(value, required=("mode",), code=CODE, where="resize")
        return ResizeNone()
    if mode == "percent":
        raw = v.obj(value, required=("mode", "percent", "allowUpscale"), code=CODE, where="resize")
        percent = v.number(raw["percent"], code=CODE, where="resize.percent")
        upscale = v.boolean(raw["allowUpscale"], code=CODE, where="resize.allowUpscale")
        if percent <= 0:
            raise v.fail(CODE, "resize.percent: out of range")
        if percent > 100 and not upscale:
            raise v.fail(CODE, "resize.percent: upscale not allowed")
        return ResizePercent(percent=percent, allow_upscale=upscale)
    if mode == "dimensions":
        raw = v.obj(
            value,
            required=("mode", "keepAspectRatio", "allowUpscale"),
            optional=("width", "height"),
            code=CODE,
            where="resize",
        )
        width = None if raw.get("width") is None else _pixels(raw["width"], "resize.width")
        height = None if raw.get("height") is None else _pixels(raw["height"], "resize.height")
        keep = v.boolean(raw["keepAspectRatio"], code=CODE, where="resize.keepAspectRatio")
        upscale = v.boolean(raw["allowUpscale"], code=CODE, where="resize.allowUpscale")
        if keep and width is None and height is None:
            raise v.fail(CODE, "resize: width or height required")
        if not keep and (width is None or height is None):
            raise v.fail(CODE, "resize: width and height required")
        return ResizeDimensions(
            width=width, height=height, keep_aspect_ratio=keep, allow_upscale=upscale
        )
    if mode == "maxEdge":
        raw = v.obj(value, required=("mode", "maxEdge"), code=CODE, where="resize")
        return ResizeMaxEdge(max_edge=_pixels(raw["maxEdge"], "resize.maxEdge"))
    raise v.fail(CODE, "resize.mode: unknown")


def _image(value: dict[str, object]) -> ImageOptions:
    raw = v.obj(
        value,
        required=("tool", "format"),
        optional=("quality", "background", "resize", "icoSizes"),
        code=CODE,
        where="options",
    )
    output = raw["format"]
    if type(output) is not str or output not in FORMAT_OPTIONS:
        raise v.fail(CODE, "format: unknown")
    quality = DEFAULT_QUALITY
    if "quality" in raw:
        quality = v.number(raw["quality"], code=CODE, where="quality")
        if not 0 <= quality <= 1:
            raise v.fail(CODE, "quality: out of range")
    background = DEFAULT_BACKGROUND
    if "background" in raw:
        background = v.string(raw["background"], code=CODE, where="background", max_length=7)
        if _BACKGROUND.fullmatch(background) is None:
            raise v.fail(CODE, "background: #rrggbb expected")
    resize: ResizeOptions = ResizeNone()
    if "resize" in raw:
        resize = parse_resize(raw["resize"])
    ico_sizes: tuple[int, ...] | None = None
    if raw.get("icoSizes") is not None:
        items = v.array(raw["icoSizes"], code=CODE, where="icoSizes", max_items=len(ICO_SIZES))
        if not items:
            raise v.fail(CODE, "icoSizes: empty")
        for item in items:
            if type(item) is not int or item not in ICO_SIZES:
                raise v.fail(CODE, "icoSizes: unknown size")
        if len(set(items)) != len(items):
            raise v.fail(CODE, "icoSizes: duplicate values")
        if output not in {"ico", "original"}:
            raise v.fail(CODE, "icoSizes: only with ico")
        ico_sizes = tuple(items)
    if output == "ico" and not isinstance(resize, ResizeNone):
        raise v.fail(CODE, "resize: only none with ico")
    return ImageOptions(
        tool=str(raw["tool"]),
        format=output,
        quality=quality,
        background=background,
        resize=resize,
        ico_sizes=ico_sizes,
    )


def _pdf(value: dict[str, object]) -> PdfOptions:
    raw = v.obj(value, required=("tool",), optional=("levels",), code=CODE, where="options")
    if "levels" not in raw:
        return PdfOptions()
    items = v.array(raw["levels"], code=CODE, where="levels", max_items=len(PDF_LEVELS))
    if not items:
        raise v.fail(CODE, "levels: empty")
    for item in items:
        if type(item) is not str or item not in PDF_LEVELS:
            raise v.fail(CODE, "levels: unknown level")
    if len(set(items)) != len(items):
        raise v.fail(CODE, "levels: duplicate values")
    return PdfOptions(levels=tuple(items))


def _audio(value: dict[str, object]) -> AudioOptions:
    raw = v.obj(
        value,
        required=("tool", "format"),
        optional=("quality", "channels"),
        code=CODE,
        where="options",
    )
    output = raw["format"]
    if type(output) is not str or output not in AUDIO_FORMATS:
        raise v.fail(CODE, "format: unknown")
    quality = DEFAULT_AUDIO_QUALITY
    if "quality" in raw:
        # Wie bei Bildern: bei WAV/FLAC zulässig, aber ohne Wirkung.
        quality = v.number(raw["quality"], code=CODE, where="quality")
        if not 0 <= quality <= 1:
            raise v.fail(CODE, "quality: out of range")
    channels = "original"
    if "channels" in raw:
        channels = v.string(raw["channels"], code=CODE, where="channels", max_length=16)
        if channels not in AUDIO_CHANNELS:
            raise v.fail(CODE, "channels: unknown")
    return AudioOptions(format=output, quality=quality, channels=channels)


def _markdown(value: dict[str, object]) -> MarkdownOptions:
    raw = v.obj(
        value,
        required=("tool",),
        optional=("pageSize", "orientation"),
        code=CODE,
        where="options",
    )
    page_size = "a4"
    if "pageSize" in raw:
        page_size = v.string(raw["pageSize"], code=CODE, where="pageSize", max_length=16)
        if page_size not in MARKDOWN_PAGE_SIZES:
            raise v.fail(CODE, "pageSize: unknown")
    orientation = "portrait"
    if "orientation" in raw:
        orientation = v.string(raw["orientation"], code=CODE, where="orientation", max_length=16)
        if orientation not in MARKDOWN_ORIENTATIONS:
            raise v.fail(CODE, "orientation: unknown")
    return MarkdownOptions(page_size=page_size, orientation=orientation)


def _pdf_merge(value: dict[str, object]) -> PdfMergeOptions:
    v.obj(value, required=("tool",), code=CODE, where="options")
    return PdfMergeOptions()


def parse_options(value: object) -> JobOptions:
    """Prüft dekodiertes Options-JSON; Fehler: ``ProtocolError("invalid-options")``."""
    if type(value) is not dict:
        raise v.fail(CODE, "options: object expected")
    tool = value.get("tool")
    if tool in IMAGE_TOOLS:
        return _image(value)
    if tool == PDF_TOOL:
        return _pdf(value)
    if tool == AUDIO_TOOL:
        return _audio(value)
    if tool == MARKDOWN_TOOL:
        return _markdown(value)
    if tool == PDF_MERGE_TOOL:
        return _pdf_merge(value)
    raise v.fail(CODE, "tool: unknown")
