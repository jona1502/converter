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


def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(part.capitalize() for part in rest)


# Protokollname -> Attributname, z. B. imageMaxInputBytes -> image_max_input_bytes.
FIELDS: Final = {_camel(item.name): item.name for item in fields(Limits)}


def parse_limits(value: object) -> Limits:
    raw = v.obj(value, required=FIELDS, code=CODE, where="limits")
    return Limits(
        **{
            attribute: v.integer(
                raw[name], code=CODE, where=f"limits.{name}", minimum=1, maximum=MAX_LIMIT
            )
            for name, attribute in FIELDS.items()
        }
    )
