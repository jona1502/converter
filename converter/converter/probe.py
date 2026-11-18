"""Echte Rundreise kleiner, im Speicher erzeugter Fixtures (Capabilities).

Wie ``backend/app/api/capabilities.py`` bzw. ``capabilities()`` der
Bildpipeline, aber zusätzlich mit den Encoderparametern der Pipeline für
jedes Ausgabeformat, einer PDF-Rundreise mit pikepdf und Audio-Rundreisen
mit soundfile (libsndfile aus dem Wheel). Schreibt nichts auf die Platte und
läuft nach ``sandbox.isolate``.
"""

from __future__ import annotations

import io
import platform
import zlib
from typing import Any

import numpy as np
import pikepdf
import PIL
import pypdfium2 as pdfium  # type: ignore[import-untyped]
import soundfile as sf
from PIL import Image

from converter.limits import Limits
from converter.processing.audio import pipeline as audio
from converter.processing.images.pipeline import INPUTS, OUTPUTS, flatten, save_options
from converter.processing.markdown.pipeline import render_pdf
from converter.processing.pdfimage.pipeline import pixel_size
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


AUDIO_RATE = 44_100
AUDIO_FRAMES = 4410
# Testsignal zum Schreiben der Eingabeproben (Container, Subtyp).
AUDIO_SAMPLES = {
    "mp3": ("MP3", "MPEG_LAYER_III"),
    "wav": ("WAV", "PCM_16"),
    "flac": ("FLAC", "PCM_16"),
    "ogg": ("OGG", "VORBIS"),
}


def _tone() -> Any:
    t = np.arange(AUDIO_FRAMES) / AUDIO_RATE
    left = 0.5 * np.sin(2 * np.pi * 440 * t)
    return np.stack([left, left], axis=1)


def _audible(data: bytes, name: str) -> bool:
    with sf.SoundFile(io.BytesIO(data)) as decoded:
        samples = decoded.read(dtype="float64", always_2d=True)
        return bool(
            audio.CONTAINERS.get(decoded.format) == name
            and decoded.samplerate == AUDIO_RATE
            and decoded.channels == 2
            and len(samples) > AUDIO_FRAMES // 2
            and float(np.max(np.abs(samples))) > 0.25
        )


def probe_audio_input(name: str) -> bool:
    try:
        container, subtype = AUDIO_SAMPLES[name]
        buffer = io.BytesIO()
        sf.write(buffer, _tone(), AUDIO_RATE, format=container, subtype=subtype)
        return _audible(buffer.getvalue(), name)
    except (sf.LibsndfileError, RuntimeError, ValueError, TypeError, KeyError):
        return False


def probe_audio_output(name: str) -> bool:
    """Kodiert mit Container, Subtyp und Qualitätsstufe der Pipeline."""
    try:
        container, subtype = audio.target_format(name, "PCM_16")
        buffer = io.BytesIO()
        with sf.SoundFile(
            buffer,
            "w",
            samplerate=AUDIO_RATE,
            channels=2,
            subtype=subtype,
            format=container,
            **audio.encoder_options(name, 0.8),
        ) as encoded:
            encoded.write(_tone())
        return _audible(buffer.getvalue(), name)
    except (sf.LibsndfileError, RuntimeError, ValueError, TypeError, AssertionError):
        return False


def probe_markdown() -> bool:
    try:
        data, count = render_pdf("# Grüße\n\nMarkdown **PDF**", Limits())
        with pikepdf.Pdf.open(io.BytesIO(data), attempt_recovery=False) as pdf:
            return count == len(pdf.pages) == 1 and bool(pdf.pages[0].Resources.Font)
    except Exception:
        return False


def probe_pdf_image() -> bool:
    """Rastert eine kleine PDF mit PDFium und prüft Größe und Farbe des Bildes."""
    try:
        with pikepdf.Pdf.new() as pdf:
            page = pdf.add_blank_page(page_size=(SIDE, SIDE))
            page.Contents = pdf.make_stream(f"1 0 0 rg 0 0 {SIDE} {SIDE} re f".encode())
            buffer = io.BytesIO()
            pdf.save(buffer)
        document = pdfium.PdfDocument(buffer.getvalue())
        try:
            pdf_page = document[0]
            try:
                bitmap = pdf_page.render(scale=1, rev_byteorder=True, may_draw_forms=False)
                image = bitmap.to_pil().convert("RGB")
                bitmap.close()
            finally:
                pdf_page.close()
        finally:
            document.close()
        return image.size == pixel_size(SIDE, SIDE, 72) and _red(image)
    except Exception:
        return False


def run_probe() -> dict[str, Any]:
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "inputFormats": [name for name in INPUTS if probe_input(name)],
        "outputFormats": [name for name in OUTPUTS if probe_output(name)],
        "pdf": probe_pdf(),
        "markdown": {"available": probe_markdown()},
        "pdfImage": {"available": probe_pdf_image()},
        "audio": {
            "inputFormats": [name for name in audio.INPUTS if probe_audio_input(name)],
            "outputFormats": [name for name in audio.OUTPUTS if probe_audio_output(name)],
        },
        "versions": {
            "python": platform.python_version(),
            "pillow": PIL.__version__,
            "pikepdf": pikepdf.__version__,
            "qpdf": pikepdf.__libqpdf_version__,
            "soundfile": sf.__version__,
            "libsndfile": sf.__libsndfile_version__,
            "numpy": np.__version__,
        },
    }
