"""Conservative PDF processing; unsupported images and document structures survive."""

from __future__ import annotations

import hashlib
import io
import warnings
import zlib
from collections import Counter
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any, BinaryIO, cast

import pikepdf
from pikepdf import Array, Dictionary, Name, Pdf
from PIL import Image

from app.core.config import Settings
from app.processing.errors import ProcessingError
from app.processing.pdf.inspection import eff_dpi, inspect_document

LEVELS = {"high": (300, 3600, 85), "balanced": (150, 2000, 72), "small": (100, 1300, 55)}


@contextmanager
def open_source(source: Path, settings: Settings) -> Iterator[Pdf]:
    if source.stat().st_size > settings.pdf_max_input_bytes:
        raise ProcessingError("file-too-large", "PDF exceeds input limit")
    with source.open("rb") as stream:
        if b"%PDF-" not in stream.read(1024):
            raise ProcessingError("not-pdf", "PDF signature missing")
    try:
        pdf = Pdf.open(source, attempt_recovery=False)
    except pikepdf.PasswordError as exc:
        raise ProcessingError("encrypted", "Encrypted PDF") from exc
    except (pikepdf.PdfError, ValueError) as exc:
        raise ProcessingError("parse-failed", "Invalid PDF") from exc
    try:
        if pdf.is_encrypted:
            raise ProcessingError("encrypted", "Encrypted PDF")
        yield pdf
    finally:
        pdf.close()


def single_filter(obj: Any) -> Any:
    value = obj.get("/Filter")
    if isinstance(value, Array):
        return value[0] if len(value) == 1 else None
    return value


def skip_reason(obj: Any, settings: Settings) -> str | None:
    try:
        width, height = int(obj.get("/Width", 0)), int(obj.get("/Height", 0))
        if width <= 0 or height <= 0:
            return "invalid-dict"
        if obj.get("/ImageMask", False):
            return "image-mask"
        flt = single_filter(obj)
        if flt not in (Name.DCTDecode, Name.FlateDecode):
            return "filter"
        cs = obj.get("/ColorSpace")
        if cs == Name.DeviceCMYK:
            return "cmyk"
        if cs not in (Name.DeviceRGB, Name.DeviceGray):
            return "colorspace"
        if int(obj.get("/BitsPerComponent", 0)) != 8:
            return "bits-per-component"
        if "/Decode" in obj:
            return "decode-array"
        if any(key in obj for key in ("/Mask", "/SMask", "/Alternates")):
            return "mask"
        if width * height > settings.pdf_image_max_pixels:
            return "too-many-pixels"
        params = obj.get("/DecodeParms")
        if isinstance(params, Array):
            params = params[0] if len(params) == 1 else Dictionary(Unsupported=True)
        if params is not None and len(params):
            pred = int(params.get("/Predictor", 1))
            allowed = {"/Predictor", "/Colors", "/BitsPerComponent", "/Columns"}
            png = (
                flt == Name.FlateDecode
                and 10 <= pred <= 15
                and int(params.get("/Colors", 1)) == (1 if cs == Name.DeviceGray else 3)
                and int(params.get("/BitsPerComponent", 8)) == 8
                and int(params.get("/Columns", 1)) == width
                and set(params.keys()) <= allowed
            )
            if not png and not (pred == 1 and set(params.keys()) <= {"/Predictor"}):
                return "decode-parms"
        return None
    except (ValueError, TypeError, pikepdf.PdfError):
        return "invalid-dict"


def _summary(pdf: Pdf, source: Path, settings: Settings) -> dict[str, Any]:
    inspection = inspect_document(pdf)
    skipped: Counter[str] = Counter()
    filters: dict[str, int] = {"dct": 0, "flate": 0, "none": 0, "other": 0}
    total_bytes = recompressible_bytes = 0
    for rec in inspection.images.values():
        obj = rec.obj
        raw_size = len(obj.read_raw_bytes())
        total_bytes += raw_size
        flt = single_filter(obj)
        kind = (
            "dct"
            if flt == Name.DCTDecode
            else "flate"
            if flt == Name.FlateDecode
            else "none"
            if flt is None and "/Filter" not in obj
            else "other"
        )
        filters[kind] += 1
        reason = skip_reason(obj, settings)
        if reason:
            skipped[reason] += 1
        else:
            recompressible_bytes += raw_size
    masks: dict[tuple[int, int], Any] = {}
    fonts: dict[tuple[int, int], Any] = {}
    signatures = 0
    for obj in pdf.objects:
        if not isinstance(obj, (Dictionary, pikepdf.Stream)):
            continue
        for key in ("/Mask", "/SMask"):
            mask = obj.get(key)
            if isinstance(mask, pikepdf.Stream):
                masks[mask.objgen] = mask
        for key in ("/FontFile", "/FontFile2", "/FontFile3"):
            font = obj.get(key)
            if isinstance(font, pikepdf.Stream):
                fonts[font.objgen] = font
        if obj.get("/Type") == Name.Sig:
            signatures += 1
    font_bytes = sum(len(obj.read_raw_bytes()) for obj in fonts.values())
    unknown = sum(eff_dpi(rec) is None for rec in inspection.images.values())
    limitations: list[dict[str, Any]] = []
    if not inspection.images:
        limitations.append({"code": "no-images"})
    for code, count in (
        ("images-not-recompressible", sum(skipped.values())),
        ("image-size-unknown", unknown),
        ("signatures-invalidated", signatures),
    ):
        if count:
            limitations.append({"code": code, "count": count})
    if font_bytes:
        limitations.append({"code": "embedded-fonts-unchanged", "bytes": font_bytes})
    return {
        "fileSize": source.stat().st_size,
        "pdfVersion": str(pdf.pdf_version),
        "pageCount": len(pdf.pages),
        "encrypted": False,
        "images": {
            "total": len(inspection.images),
            "recompressible": len(inspection.images) - sum(skipped.values()),
            "skipped": dict(skipped),
            "byFilter": filters,
            "bytes": total_bytes + sum(len(obj.read_raw_bytes()) for obj in masks.values()),
            "recompressibleBytes": recompressible_bytes,
            "maskCount": len(masks),
        },
        "fontBytes": font_bytes,
        "limitations": limitations,
    }


def analyze(source: Path, settings: Settings) -> dict[str, Any]:
    try:
        with open_source(source, settings) as pdf:
            return _summary(pdf, source, settings)
    except (pikepdf.PdfError, ValueError, TypeError, OverflowError) as exc:
        raise ProcessingError("parse-failed", "PDF analysis failed") from exc


class LimitedWriter:
    def __init__(self, stream: Any, limit: int) -> None:
        self.stream, self.limit = stream, limit

    def write(self, data: bytes) -> int:
        if self.stream.tell() + len(data) > self.limit:
            raise ProcessingError("result-too-large", "PDF output exceeds limit")
        return int(self.stream.write(data))

    def tell(self) -> int:
        return int(self.stream.tell())

    def seek(self, offset: int, whence: int = 0) -> int:
        return int(self.stream.seek(offset, whence))

    def flush(self) -> None:
        self.stream.flush()


def compress(
    source: Path, target: Path, level: str, settings: Settings, progress: Callable[[int, int], None]
) -> dict[str, Any]:
    if level not in LEVELS:
        raise ProcessingError("invalid-options", "Unknown PDF level")
    dpi_target, edge, quality = LEVELS[level]
    details: dict[str, Any] = {
        "originalSize": source.stat().st_size,
        "imagesRecompressed": 0,
        "imagesResized": 0,
        "imagesSkipped": 0,
        "imagesNotSmaller": 0,
        "streamsCompressed": 0,
        "objectsRemoved": 0,
        "notes": [],
    }
    try:
        with open_source(source, settings) as pdf:
            summary = _summary(pdf, source, settings)
            records = list(inspect_document(pdf).images.values())
            progress(0, len(records))
            for current, rec in enumerate(records, 1):
                obj = rec.obj
                reason = skip_reason(obj, settings)
                if reason:
                    details["imagesSkipped"] += 1
                else:
                    width, height = int(obj.Width), int(obj.Height)
                    dpi = eff_dpi(rec)
                    scale = min(1.0, edge / max(width, height), dpi_target / dpi if dpi else 1.0)
                    if scale > 0.9:
                        scale = 1.0
                    size = (max(1, round(width * scale)), max(1, round(height * scale)))
                    if single_filter(obj) == Name.DCTDecode and size == (width, height):
                        details["imagesNotSmaller"] += 1
                    else:
                        try:
                            with warnings.catch_warnings():
                                warnings.simplefilter("error", Image.DecompressionBombWarning)
                                image = pikepdf.PdfImage(obj).as_pil_image()
                                if image.mode not in ("RGB", "L") or image.size != (width, height):
                                    raise ValueError("Image dictionary mismatch")
                                if size != image.size:
                                    image = image.resize(size, Image.Resampling.LANCZOS)
                                buffer = io.BytesIO()
                                image.save(buffer, "JPEG", quality=quality, optimize=True)
                                encoded = buffer.getvalue()
                            if len(encoded) <= len(obj.read_raw_bytes()) * 0.97:
                                obj.write(encoded, filter=Name.DCTDecode)
                                obj.Width, obj.Height = size
                                if "/DecodeParms" in obj:
                                    del obj.DecodeParms
                                details["imagesRecompressed"] += 1
                                details["imagesResized"] += size != (width, height)
                            else:
                                details["imagesNotSmaller"] += 1
                        except (
                            OSError,
                            ValueError,
                            pikepdf.PdfError,
                            Image.DecompressionBombWarning,
                            Image.DecompressionBombError,
                        ):
                            details["imagesSkipped"] += 1
                progress(current, len(records))
            # qpdf drops unreachable objects on save; do not alter document resources.
            # Only count streams whose actual encoding changed to Flate, by
            # matching decoded bytes; object numbers can change during save.
            plain_streams = [
                obj.read_raw_bytes()
                for obj in pdf.objects
                if isinstance(obj, pikepdf.Stream)
                and "/Filter" not in obj
                and len(obj.read_raw_bytes()) > 0
            ]
            max_plain = max(map(len, plain_streams), default=0)
            uncompressed = Counter(hashlib.sha256(data).digest() for data in plain_streams)
            del plain_streams
            before_count = len(pdf.objects)
            with target.open("wb") as stream:
                pdf.save(
                    cast(BinaryIO, LimitedWriter(stream, settings.pdf_max_results_total_bytes)),
                    compress_streams=True,
                    object_stream_mode=pikepdf.ObjectStreamMode.preserve,
                )
            with Pdf.open(target, attempt_recovery=False) as output:
                details["objectsRemoved"] = max(0, before_count - len(output.objects))
                for obj in output.objects:
                    if isinstance(obj, pikepdf.Stream) and single_filter(obj) == Name.FlateDecode:
                        if not uncompressed or obj.get("/DecodeParms") is not None:
                            continue
                        decoder = zlib.decompressobj()
                        try:
                            plain = decoder.decompress(obj.read_raw_bytes(), max_plain + 1)
                        except zlib.error:
                            continue
                        if len(plain) > max_plain or not decoder.eof:
                            continue
                        digest = hashlib.sha256(plain).digest()
                        if uncompressed[digest]:
                            details["streamsCompressed"] += 1
                            uncompressed[digest] -= 1
            for field, code in (
                ("imagesSkipped", "images-skipped"),
                ("imagesNotSmaller", "images-not-smaller"),
            ):
                if details[field]:
                    details["notes"].append({"code": code, "count": details[field]})
            details["notes"].extend(
                note
                for note in summary["limitations"]
                if note["code"] in {"image-size-unknown", "signatures-invalidated"}
            )
            return details
    except ProcessingError:
        target.unlink(missing_ok=True)
        raise
    except (pikepdf.PdfError, OSError, ValueError, TypeError, OverflowError) as exc:
        target.unlink(missing_ok=True)
        raise ProcessingError("save-failed", "PDF processing failed") from exc
