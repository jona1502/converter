"""Tatsächlich verfügbare Encoder und veröffentlichte Betriebsgrenzen."""

from __future__ import annotations

from functools import lru_cache
from typing import Any

from fastapi import APIRouter

from app.api import API_PREFIX
from app.api.deps import SettingsDep
from app.processing.images.pipeline import capabilities as image_capabilities

router = APIRouter(prefix=API_PREFIX, tags=["capabilities"])


@lru_cache(maxsize=1)
def probes() -> dict[str, dict[str, bool]]:
    return image_capabilities()


def ready() -> bool:
    values = probes()
    return all(values["input"].values()) and all(values["output"].values())


@router.get("/capabilities")
def capabilities(settings: SettingsDep) -> dict[str, Any]:
    values = probes()
    return {
        "apiVersion": "1",
        "tools": ["image-convert", "image-compress", "image-resize", "pdf-compress"],
        "image": {
            "inputFormats": [key for key, value in values["input"].items() if value],
            "outputFormats": [key for key, value in values["output"].items() if value],
            "qualityFormats": ["jpeg", "webp"],
            "icoSizes": [16, 32, 48, 64, 128, 256],
            "defaultIcoSizes": [16, 32, 48, 256],
            "maxFileBytes": settings.image_max_input_bytes,
            "maxPixels": settings.image_max_pixels,
            "maxEdge": settings.image_max_edge,
            "maxOutputBytes": settings.image_max_output_bytes,
        },
        "pdf": {
            "maxFileBytes": settings.pdf_max_input_bytes,
            "maxResultBytesTotal": settings.pdf_max_results_total_bytes,
            "maxImagePixels": settings.pdf_image_max_pixels,
            "levels": [
                {
                    "level": level,
                    "targetDpi": dpi,
                    "maxImageEdge": edge,
                    "quality": quality,
                    "minDownscaleFactor": 0.9,
                }
                for level, dpi, edge, quality in [
                    ("high", 300, 3600, 0.85),
                    ("balanced", 150, 2000, 0.72),
                    ("small", 100, 1300, 0.55),
                ]
            ],
        },
        "jobs": {
            "ttlSeconds": settings.job_ttl_seconds,
            "maxActivePerSession": settings.session_max_active_jobs,
            "maxBatchFiles": 30,
            "createPerMinute": settings.session_creates_per_minute,
        },
    }
