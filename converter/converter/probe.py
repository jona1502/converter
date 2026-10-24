"""Echte Rundreise kleiner, im Speicher erzeugter Fixtures (Capabilities).

Wie ``backend/app/api/capabilities.py`` bzw. ``capabilities()`` der
Bildpipeline, aber zusätzlich mit den Encoderparametern der Pipeline für
jedes Ausgabeformat und einer PDF-Rundreise mit pikepdf. Schreibt nichts
auf die Platte und läuft nach ``sandbox.isolate``.
"""

from __future__ import annotations

import io
import platform
import zlib
from typing import Any

import pikepdf
import PIL
from PIL import Image

from converter.processing.images.pipeline import INPUTS, OUTPUTS, flatten, save_options
from converter.protocol import PROTOCOL_VERSION

SIDE = 32
RED = (255, 0, 0)
# Verlustbehaftete Codecs (JPEG, WebP, AVIF) weichen leicht ab.
TOLERANCE = 24


def _red(image: Image.Image) -> bool:
    pixel = image.convert("RGB").getpixel((SIDE // 2, SIDE // 2))
    return isinstance(pixel, tuple) and all(
        abs(int(a) - b) <= TOLERANCE for a, b in zip(pixel, RED, strict=True)
    )


def _decodes(data: bytes, name: str, size: tuple[int, int]) -> bool:
    with Image.open(io.BytesIO(data), formats=[name.upper()]) as decoded:
        decoded.load()
        return (decoded.format or "").lower() == name and decoded.size == size and _red(decoded)


def probe_input(name: str) -> bool:
    try:
        buffer = io.BytesIO()
        Image.new("RGB", (SIDE, SIDE), RED).save(buffer, format=name.upper())
        return _decodes(buffer.getvalue(), name, (SIDE, SIDE))
    except (OSError, ValueError, KeyError):
        return False


def probe_output(name: str) -> bool:
    """Kodiert wie die Pipeline (Alpha, Qualität, ICO-Größen) und dekodiert erneut."""
    try:
        image = Image.new("RGBA", (SIDE, SIDE), (*RED, 255))
        if name in {"jpeg", "bmp"}:
            image = flatten(image, "#ffffff")
        sizes = [16, SIDE]
        buffer = io.BytesIO()
        image.save(buffer, format=name.upper(), **save_options(name, 0.85, sizes))
        return _decodes(buffer.getvalue(), name, (SIDE, SIDE))
    except (OSError, ValueError, KeyError):
        return False


def probe_pdf() -> bool:
    """Erzeugen, Speichern, strenges Öffnen, Bild neu kodieren, erneut speichern."""
    try:
        with pikepdf.Pdf.new() as pdf:
            page = pdf.add_blank_page(page_size=(72, 72))
            pixels = Image.new("RGB", (SIDE, SIDE), RED)
            stream = pdf.make_stream(zlib.compress(pixels.tobytes()))
            stream.Type, stream.Subtype = pikepdf.Name.XObject, pikepdf.Name.Image
            stream.Width, stream.Height, stream.BitsPerComponent = SIDE, SIDE, 8
            stream.ColorSpace = pikepdf.Name.DeviceRGB
            stream.Filter = pikepdf.Name.FlateDecode
            page.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im=stream))
            page.Contents = pdf.make_stream(b"q 72 0 0 72 0 0 cm /Im Do Q")
            first = io.BytesIO()
            pdf.save(first)
        with pikepdf.Pdf.open(io.BytesIO(first.getvalue()), attempt_recovery=False) as pdf:
            image = pdf.pages[0].Resources.XObject.Im
            if not isinstance(image, pikepdf.Stream):
                return False
            decoded = pikepdf.PdfImage(image).as_pil_image()
            if decoded.size != (SIDE, SIDE) or not _red(decoded):
                return False
            jpeg = io.BytesIO()
            decoded.save(jpeg, "JPEG", quality=85, optimize=True)
            image.write(jpeg.getvalue(), filter=pikepdf.Name.DCTDecode)
            second = io.BytesIO()
            pdf.save(second, compress_streams=True)
        with pikepdf.Pdf.open(io.BytesIO(second.getvalue()), attempt_recovery=False) as pdf:
            image = pdf.pages[0].Resources.XObject.Im
            return bool(image.Filter == pikepdf.Name.DCTDecode and len(pdf.pages) == 1)
    except (pikepdf.PdfError, OSError, ValueError, KeyError, AttributeError):
        return False


def run_probe() -> dict[str, Any]:
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "inputFormats": [name for name in INPUTS if probe_input(name)],
        "outputFormats": [name for name in OUTPUTS if probe_output(name)],
        "pdf": probe_pdf(),
        "versions": {
            "python": platform.python_version(),
            "pillow": PIL.__version__,
            "pikepdf": pikepdf.__version__,
            "qpdf": pikepdf.__libqpdf_version__,
        },
    }
