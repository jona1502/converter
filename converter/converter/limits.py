"""Verarbeitungsgrenzen (Vertrag Abschnitt 6), vom Go-Worker je Auftrag übergeben.

Attributnamen wie ``backend/app/core/config.py``, damit die übernommenen
Algorithmen unverändert lesbar bleiben; im Protokoll camelCase.
"""

from __future__ import annotations

from dataclasses import dataclass, fields
from typing import Final

from converter import validation as v

CODE: Final = "protocol-error"
MAX_LIMIT: Final = 2**53  # verlustfrei in JSON/float64 und Go int64


@dataclass(frozen=True, slots=True)
class Limits:
    image_max_input_bytes: int = 52_428_800
    image_max_pixels: int = 40_000_000
    image_max_edge: int = 16_384
    image_max_output_bytes: int = 104_857_600
    pdf_max_input_bytes: int = 100_000_000
    pdf_max_results_total_bytes: int = 300_000_000
    pdf_image_max_pixels: int = 40_000_000
    audio_max_input_bytes: int = 104_857_600
    audio_max_duration_seconds: int = 1800
    audio_max_channels: int = 8
    audio_max_sample_rate: int = 192_000
    audio_max_output_bytes: int = 419_430_400
    markdown_max_input_bytes: int = 2_097_152
    markdown_max_output_bytes: int = 20_971_520
    markdown_max_pages: int = 300
    image_pdf_max_images: int = 30
    image_pdf_max_input_bytes: int = 104_857_600
    pdf_render_max_pages: int = 100


def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(part.capitalize() for part in rest)


# Protokollname -> Attributname, z. B. imageMaxInputBytes -> image_max_input_bytes.
FIELDS: Final = {_camel(item.name): item.name for item in fields(Limits)}


def parse_limits(value: object) -> Limits:
    optional = {name for name in FIELDS if name.startswith(("markdown", "imagePdf", "pdfRender"))}
    raw = v.obj(
        value, required=FIELDS.keys() - optional, optional=optional, code=CODE, where="limits"
    )
    return Limits(
        **{
            attribute: v.integer(
                raw[name], code=CODE, where=f"limits.{name}", minimum=1, maximum=MAX_LIMIT
            )
            for name, attribute in FIELDS.items()
            if name in raw
        }
    )
