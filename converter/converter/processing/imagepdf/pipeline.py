"""Bild zu PDF; läuft nur im isolierten Konverterprozess.

Eingabe ist ein ZIP-Bündel mit ungepackten Einträgen 001.ext, 002.ext, ...
(siehe ``jobs.ValidateImageBundle`` in Go, das dieselben Regeln vorab prüft).
Jedes Bild wird mit den Grenzen der Bildwerkzeuge dekodiert (Bytes, Pixel,
Kantenlänge, keine Animation) und als eigene PDF-Seite eingebettet. JPEG ohne
Drehung, Farbprofil oder CMYK wird unverändert übernommen, alles andere als
8-Bit-RGB (bzw. Graustufen) mit Flate; Transparenz wird auf Weiß gelegt.
Es werden weder EXIF noch Farbprofile oder andere Bildmetadaten kopiert.
"""

from __future__ import annotations

import io
import re
import warnings
import zipfile
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

import pikepdf
from PIL import Image, ImageCms, ImageOps, UnidentifiedImageError

from converter.errors import ProcessingError
from converter.limits import Limits
from converter.options import ImagePdfOptions
from converter.processing.images.pipeline import _BoundedWriter, _limits, flatten

INPUTS: Final = ("jpeg", "png", "webp", "gif", "bmp")
PAGE_SIZES: Final = {"a4": (595.28, 841.89), "letter": (612.0, 792.0)}
MARGIN_MM: Final = {"none": 0.0, "small": 10.0, "medium": 20.0}
POINTS_PER_MM: Final = 72 / 25.4
# "Seite wie das Bild": 1 Pixel entspricht 0,75 pt (96 dpi).
FIT_POINTS_PER_PIXEL: Final = 0.75
_ENTRY = re.compile(r"(\d{3})\.[a-z0-9]{2,5}")
_ORIENTATION_TAG: Final = 274
_WHITE: Final = "#ffffff"


@dataclass(frozen=True, slots=True)
class _Embedded:
    width: int
    height: int
    colorspace: str
    filter: str
    data: bytes


def _entries(archive: zipfile.ZipFile, limits: Limits) -> list[zipfile.ZipInfo]:
    infos = archive.infolist()
    if not infos:
        raise ProcessingError("decode-failed")
    if len(infos) > limits.image_pdf_max_images:
        raise ProcessingError("file-too-large")
    total = 0
    for index, info in enumerate(infos, start=1):
        match = _ENTRY.fullmatch(info.filename)
        if (
            match is None
            or int(match.group(1)) != index
            or info.is_dir()
            or info.flag_bits & 0x1
            or info.compress_type != zipfile.ZIP_STORED
            or info.file_size == 0
        ):
            raise ProcessingError("decode-failed")
        if info.file_size > limits.image_max_input_bytes:
            raise ProcessingError("file-too-large")
        total += info.file_size
        if total > limits.image_pdf_max_input_bytes:
            raise ProcessingError("file-too-large")
    return infos


def _srgb(image: Image.Image) -> Image.Image:
    profile = image.info.get("icc_profile")
    if not profile:
        return image
    try:
        converted = ImageCms.profileToProfile(
            image,
            ImageCms.ImageCmsProfile(io.BytesIO(profile)),
            ImageCms.createProfile("sRGB"),
            outputMode="RGBA" if "A" in image.getbands() else "RGB",
        )
    except (ImageCms.PyCMSError, OSError, ValueError) as exc:
        raise ProcessingError("decode-failed") from exc
    if converted is None:
        raise ProcessingError("decode-failed")
    return converted


def _has_alpha(image: Image.Image) -> bool:
    return "A" in image.getbands() or "transparency" in image.info


def _embed(data: bytes, limits: Limits) -> _Embedded:
    with Image.open(io.BytesIO(data)) as opened:
        source_format = (opened.format or "").lower()
        if source_format not in INPUTS:
            raise ProcessingError("unsupported-type")
        _limits(*opened.size, limits)
        if getattr(opened, "is_animated", False):
            raise ProcessingError("animated-unsupported")
        opened.load()
        plain_jpeg = (
            source_format == "jpeg"
            and opened.mode in {"RGB", "L"}
            and opened.getexif().get(_ORIENTATION_TAG, 1) == 1
            and not opened.info.get("icc_profile")
        )
        if plain_jpeg:
            space = "/DeviceRGB" if opened.mode == "RGB" else "/DeviceGray"
            return _Embedded(opened.width, opened.height, space, "/DCTDecode", data)
        image = _srgb(ImageOps.exif_transpose(opened))
        _limits(*image.size, limits)
        if _has_alpha(image):
            image = flatten(image.convert("RGBA"), _WHITE)
        elif image.mode == "L":
            return _Embedded(
                image.width,
                image.height,
                "/DeviceGray",
                "/FlateDecode",
                zlib.compress(image.tobytes(), 6),
            )
        elif image.mode != "RGB":
            image = image.convert("RGB")
        return _Embedded(
            image.width,
            image.height,
            "/DeviceRGB",
            "/FlateDecode",
            zlib.compress(image.tobytes(), 6),
        )


def _decoded(data: bytes, limits: Limits) -> _Embedded:
    try:
        return _embed(data, limits)
    except UnidentifiedImageError as exc:
        raise ProcessingError("unsupported-type") from exc
    except (Image.DecompressionBombError, Image.DecompressionBombWarning, OverflowError) as exc:
        raise ProcessingError("dimensions-too-large") from exc
    except (OSError, ValueError, EOFError, SyntaxError) as exc:
        raise ProcessingError("decode-failed") from exc


def page_geometry(
    width: int, height: int, options: ImagePdfOptions
) -> tuple[tuple[float, float], tuple[float, float, float, float]]:
    """Seitengröße und Bildplatzierung ``(w, h, x, y)`` in Punkten."""
    margin = MARGIN_MM[options.margin] * POINTS_PER_MM
    if options.page_size == "fit":
        draw_w, draw_h = width * FIT_POINTS_PER_PIXEL, height * FIT_POINTS_PER_PIXEL
        return (draw_w + 2 * margin, draw_h + 2 * margin), (draw_w, draw_h, margin, margin)
    short, long = sorted(PAGE_SIZES[options.page_size])
    landscape = options.orientation == "landscape" or (
        options.orientation == "auto" and width > height
    )
    page = (long, short) if landscape else (short, long)
    scale = min((page[0] - 2 * margin) / width, (page[1] - 2 * margin) / height)
    draw_w, draw_h = width * scale, height * scale
    return page, (draw_w, draw_h, (page[0] - draw_w) / 2, (page[1] - draw_h) / 2)


def _add_page(pdf: pikepdf.Pdf, image: _Embedded, options: ImagePdfOptions) -> None:
    page_size, (w, h, x, y) = page_geometry(image.width, image.height, options)
    stream = pdf.make_stream(image.data)
    stream.Type = pikepdf.Name.XObject
    stream.Subtype = pikepdf.Name.Image
    stream.Width, stream.Height, stream.BitsPerComponent = image.width, image.height, 8
    stream.ColorSpace = pikepdf.Name(image.colorspace)
    stream.Filter = pikepdf.Name(image.filter)
    page = pdf.add_blank_page(page_size=page_size)
    page.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=stream))
    page.Contents = pdf.make_stream(f"q {w:.4f} 0 0 {h:.4f} {x:.4f} {y:.4f} cm /Im0 Do Q".encode())


def _build(source: Path, target: Path, options: ImagePdfOptions, limits: Limits) -> int:
    try:
        archive = zipfile.ZipFile(source)
    except (zipfile.BadZipFile, OSError, ValueError) as exc:
        raise ProcessingError("decode-failed") from exc
    with archive, pikepdf.Pdf.new() as pdf:
        try:
            written = 0
            for info in _entries(archive, limits):
                image = _decoded(archive.read(info), limits)
                written += len(image.data)
                if written > limits.image_max_output_bytes:
                    raise ProcessingError("result-too-large")
                _add_page(pdf, image, options)
                del image
        except (zipfile.BadZipFile, OSError, ValueError, RuntimeError, EOFError) as exc:
            raise ProcessingError("decode-failed") from exc
        count = len(pdf.pages)
        try:
            with _BoundedWriter(target, limits.image_max_output_bytes) as sink:
                pdf.save(
                    sink,
                    compress_streams=False,
                    object_stream_mode=pikepdf.ObjectStreamMode.disable,
                )
        except ProcessingError:
            raise
        except (pikepdf.PdfError, OSError, ValueError) as exc:
            raise ProcessingError("encode-failed") from exc
        return count


def convert(source: Path, target: Path, options: ImagePdfOptions, limits: Limits) -> dict[str, Any]:
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        return {"pageCount": _build(source, target, options, limits)}
