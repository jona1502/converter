"""Reject excessive image dimensions before pixel decoding in the worker."""

import warnings
from pathlib import Path

from PIL import Image, UnidentifiedImageError

from app.api.errors import ApiError, ApiErrorCode
from app.core.config import Settings


def probe_image(path: Path, settings: Settings) -> None:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(path) as image:
                width, height = image.size
                if (
                    width <= 0
                    or height <= 0
                    or width > settings.image_max_edge
                    or height > settings.image_max_edge
                    or width * height > settings.image_max_pixels
                ):
                    raise ApiError(
                        ApiErrorCode.DIMENSIONS_TOO_LARGE,
                        422,
                        "Bildabmessungen überschreiten das Limit.",
                    )
                if getattr(image, "is_animated", False):
                    raise ApiError(
                        ApiErrorCode.ANIMATED_UNSUPPORTED,
                        422,
                        "Animierte Bilder werden nicht unterstützt.",
                    )
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ApiError(
            ApiErrorCode.DIMENSIONS_TOO_LARGE,
            422,
            "Bildabmessungen überschreiten das Limit.",
        ) from exc
    except (UnidentifiedImageError, OSError, ValueError, EOFError) as exc:
        raise ApiError(ApiErrorCode.UNSUPPORTED_TYPE, 415, "Bildheader ist beschädigt.") from exc
