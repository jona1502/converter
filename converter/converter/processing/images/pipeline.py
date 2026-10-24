"""Pillow conversion core; called only inside the isolated converter process.

Übernommen aus backend/app/processing/images/pipeline.py. Algorithmus
unverändert; angepasst sind nur die Grenzen (``Limits`` statt ``Settings``),
die Optionstypen und das Öffnen der Ergebnisdatei (ohne Anlegen/Symlinks).
"""

from __future__ import annotations

import io
import math
import warnings
from pathlib import Path
from typing import Any

from PIL import Image, ImageCms, ImageOps, UnidentifiedImageError

from converter.errors import ProcessingError
from converter.limits import Limits
from converter.options import (
    ImageOptions,
    ResizeDimensions,
    ResizeMaxEdge,
    ResizeOptions,
    ResizePercent,
)
from converter.processing.files import open_result

INPUTS = ("jpeg", "png", "webp", "gif", "bmp", "ico", "avif")
OUTPUTS = ("jpeg", "png", "webp", "bmp", "ico")


class _BoundedWriter(io.BufferedWriter):
    def __init__(self, path: Path, limit: int) -> None:
        # Go pre-creates this lease-specific file with mode 0600.
        super().__init__(io.FileIO(open_result(path), "w"))
        self.limit = limit

    def fileno(self) -> int:
        # Native encoder fd writes would bypass write() and its quota.
        raise io.UnsupportedOperation("bounded writer")

    def write(self, data: Any) -> int:
        if self.tell() + len(data) > self.limit:
            raise ProcessingError("result-too-large")
        return super().write(data)


def _limits(width: int, height: int, limits: Limits) -> None:
    if (
        width <= 0
        or height <= 0
        or width > limits.image_max_edge
        or height > limits.image_max_edge
        or width * height > limits.image_max_pixels
    ):
        raise ProcessingError("dimensions-too-large")


def target_size(width: int, height: int, resize: ResizeOptions) -> tuple[int, int]:
    def edge(value: float) -> int:
        # JavaScript Math.round for positive dimensions (not bankers rounding).
        if not math.isfinite(value):
            raise ProcessingError("dimensions-too-large")
        return max(1, math.floor(value + 0.5))

    if isinstance(resize, ResizePercent):
        return edge(width * resize.percent / 100), edge(height * resize.percent / 100)
    if isinstance(resize, ResizeDimensions):
        w, h = resize.width, resize.height
        if resize.keep_aspect_ratio:
            factors = ([w / width] if w is not None else []) + ([h / height] if h else [])
            factor = min(factors)
            if not resize.allow_upscale:
                factor = min(factor, 1)
            return edge(width * factor), edge(height * factor)
        if w is None or h is None:
            raise ProcessingError("invalid-options")
        return (w, h) if resize.allow_upscale else (min(w, width), min(h, height))
    if isinstance(resize, ResizeMaxEdge):
        factor = min(1, resize.max_edge / max(width, height))
        return edge(width * factor), edge(height * factor)
    return width, height


def save_options(output: str, quality: float, ico_sizes: list[int]) -> dict[str, Any]:
    """Encoderparameter je Zielformat (auch für die Capabilities-Probe)."""
    options: dict[str, Any] = {}
    if output in {"jpeg", "webp"}:
        options["quality"] = max(1, min(95, round(quality * 100)))
    if output == "png":
        options["optimize"] = True
    if output == "ico":
        options["sizes"] = [(s, s) for s in ico_sizes]
    return options


def flatten(image: Image.Image, background: str) -> Image.Image:
    """Legt Alpha explizit auf den Hintergrund (JPEG und BMP)."""
    canvas = Image.new("RGB", image.size, background)
    canvas.paste(image, mask=image.getchannel("A"))
    return canvas


def _convert(source: Path, target: Path, options: ImageOptions, limits: Limits) -> dict[str, Any]:
    if source.stat().st_size > limits.image_max_input_bytes:
        raise ProcessingError("file-too-large")
    with Image.open(source) as opened:
        source_format = (opened.format or "").lower()
        if source_format not in INPUTS:
            raise ProcessingError("unsupported-type")
        output = options.output_format(source_format)
        if output is None:
            raise ProcessingError("original-format-unsupported")
        if output == "ico" and options.resize.mode != "none":
            raise ProcessingError("invalid-options")
        if options.ico_sizes is not None and output != "ico":
            raise ProcessingError("invalid-options")
        _limits(*opened.size, limits)
        if getattr(opened, "is_animated", False):
            raise ProcessingError("animated-unsupported")
        opened.load()
        oriented = ImageOps.exif_transpose(opened)
        sw, sh = oriented.size
        width, height = target_size(sw, sh, options.resize)
        _limits(width, height, limits)
        profile = oriented.info.get("icc_profile")
        if profile:
            try:
                color_corrected = ImageCms.profileToProfile(
                    oriented,
                    ImageCms.ImageCmsProfile(io.BytesIO(profile)),
                    ImageCms.createProfile("sRGB"),
                    outputMode="RGBA" if "A" in oriented.getbands() else "RGB",
                )
                if color_corrected is None:
                    raise ProcessingError("decode-failed")
                oriented = color_corrected
            except (ImageCms.PyCMSError, OSError, ValueError) as exc:
                raise ProcessingError("decode-failed") from exc
        image = oriented.convert("RGBA")
        transparent = image.getchannel("A").histogram()[255] < sw * sh
        if image.size != (width, height):
            image = image.resize((width, height), Image.Resampling.LANCZOS)
        upscaled = width > sw or height > sh
        if output == "ico":
            side = max(options.effective_ico_sizes())
            _limits(side, side, limits)
            # contain does not upscale; ICO explicitly does.
            factor = side / max(image.size)
            fitted = image.resize(
                (
                    max(1, math.floor(image.width * factor + 0.5)),
                    max(1, math.floor(image.height * factor + 0.5)),
                ),
                Image.Resampling.LANCZOS,
            )
            canvas = Image.new("RGBA", (side, side))
            canvas.paste(fitted, ((side - fitted.width) // 2, (side - fitted.height) // 2))
            image = canvas
            width = height = side
            upscaled = factor > 1
        flattened = transparent and output in {"jpeg", "bmp"}
        if output in {"jpeg", "bmp"}:
            image = flatten(image, options.background)
        # Fresh pixel image ensures EXIF/ICC and parser metadata are not copied.
        clean = Image.new(image.mode, image.size)
        clean.paste(image)
        encoder = save_options(output, options.quality, options.effective_ico_sizes())
        try:
            with _BoundedWriter(target, limits.image_max_output_bytes) as sink:
                clean.save(sink, format=output.upper(), **encoder)
        except (OSError, ValueError) as exc:
            raise ProcessingError("encode-failed") from exc
        return {
            "format": output,
            "width": width,
            "height": height,
            "sourceWidth": sw,
            "sourceHeight": sh,
            "upscaled": upscaled,
            "transparencyFlattened": flattened,
            "qualityApplied": output in {"jpeg", "webp"},
        }


def convert(source: Path, target: Path, options: ImageOptions, limits: Limits) -> dict[str, Any]:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            return _convert(source, target, options, limits)
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ProcessingError("dimensions-too-large") from exc
    except OverflowError as exc:
        raise ProcessingError("dimensions-too-large") from exc
    except (UnidentifiedImageError, OSError, ValueError, EOFError) as exc:
        raise ProcessingError("decode-failed") from exc
