"""Pillow conversion core; called only inside the isolated worker child."""

from __future__ import annotations

import io
import math
import warnings
from pathlib import Path
from typing import Any

from PIL import Image, ImageCms, ImageOps, UnidentifiedImageError

from app.core.config import Settings
from app.processing.errors import ProcessingError
from app.schemas.options import ImageOptions, ResizeOptions

INPUTS = ("jpeg", "png", "webp", "gif", "bmp", "ico", "avif")
OUTPUTS = ("jpeg", "png", "webp", "bmp", "ico")


class _BoundedWriter(io.BufferedWriter):
    def __init__(self, path: Path, limit: int) -> None:
        # Runner pre-creates this trusted lease-specific file with mode 0600.
        super().__init__(io.FileIO(path, "w"))
        self.limit = limit

    def fileno(self) -> int:
        # Native encoder fd writes would bypass write() and its quota.
        raise io.UnsupportedOperation("bounded writer")

    def write(self, data: Any) -> int:
        if self.tell() + len(data) > self.limit:
            raise ProcessingError("result-too-large")
        return super().write(data)


def _limits(width: int, height: int, settings: Settings) -> None:
    if (
        width <= 0
        or height <= 0
        or width > settings.image_max_edge
        or height > settings.image_max_edge
        or width * height > settings.image_max_pixels
    ):
        raise ProcessingError("dimensions-too-large")


def target_size(width: int, height: int, resize: ResizeOptions) -> tuple[int, int]:
    def edge(value: float) -> int:
        # JavaScript Math.round for positive dimensions (not bankers rounding).
        if not math.isfinite(value):
            raise ProcessingError("dimensions-too-large")
        return max(1, math.floor(value + 0.5))

    if resize.mode == "percent":
        return edge(width * resize.percent / 100), edge(height * resize.percent / 100)
    if resize.mode == "dimensions":
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
    if resize.mode == "maxEdge":
        factor = min(1, resize.max_edge / max(width, height))
        return edge(width * factor), edge(height * factor)
    return width, height


def _convert(
    source: Path, target: Path, options: ImageOptions, settings: Settings
) -> dict[str, Any]:
    if source.stat().st_size > settings.image_max_input_bytes:
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
        _limits(*opened.size, settings)
        if getattr(opened, "is_animated", False):
            raise ProcessingError("animated-unsupported")
        opened.load()
        oriented = ImageOps.exif_transpose(opened)
        sw, sh = oriented.size
        width, height = target_size(sw, sh, options.resize)
        _limits(width, height, settings)
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
            _limits(side, side, settings)
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
            background = Image.new("RGB", image.size, options.background)
            background.paste(image, mask=image.getchannel("A"))
            image = background
        # Fresh pixel image ensures EXIF/ICC and parser metadata are not copied.
        clean = Image.new(image.mode, image.size)
        clean.paste(image)
        save_options: dict[str, Any] = {}
        if output in {"jpeg", "webp"}:
            save_options["quality"] = max(1, min(95, round(options.quality * 100)))
        if output == "png":
            save_options["optimize"] = True
        if output == "ico":
            save_options["sizes"] = [(s, s) for s in options.effective_ico_sizes()]
        try:
            with _BoundedWriter(target, settings.image_max_output_bytes) as sink:
                clean.save(sink, format=output.upper(), **save_options)
        except (OSError, ValueError) as exc:
            raise ProcessingError("encode-failed") from exc
        return {
            "format": output.value,
            "width": width,
            "height": height,
            "sourceWidth": sw,
            "sourceHeight": sh,
            "upscaled": upscaled,
            "transparencyFlattened": flattened,
            "qualityApplied": output in {"jpeg", "webp"},
        }


def convert(
    source: Path, target: Path, options: ImageOptions, settings: Settings
) -> dict[str, Any]:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            return _convert(source, target, options, settings)
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ProcessingError("dimensions-too-large") from exc
    except OverflowError as exc:
        raise ProcessingError("dimensions-too-large") from exc
    except (UnidentifiedImageError, OSError, ValueError, EOFError) as exc:
        raise ProcessingError("decode-failed") from exc


def capabilities() -> dict[str, dict[str, bool]]:
    result: dict[str, dict[str, bool]] = {"input": {}, "output": {}}
    for name in INPUTS:
        try:
            sample = Image.new("RGB", (32, 32), "red")
            buffer = io.BytesIO()
            sample.save(buffer, format=name.upper())
            buffer.seek(0)
            with Image.open(buffer) as decoded:
                decoded.load()
                valid = decoded.size == sample.size
        except (OSError, ValueError, KeyError):
            valid = False
        result["input"][name] = valid
        if name in OUTPUTS:
            result["output"][name] = valid
    return result
