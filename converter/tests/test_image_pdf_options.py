"""image-pdf options and limits contract."""

from __future__ import annotations

from pathlib import Path

import pytest

from converter.errors import ProtocolError
from converter.limits import parse_limits
from converter.options import ImagePdfOptions, parse_options
from converter.protocol import parse_request
from tests.helpers import DEFAULT_LIMITS, encode, new_id, request


def test_defaults() -> None:
    parsed = parse_options({"tool": "image-pdf"})
    assert parsed == ImagePdfOptions()
    assert (parsed.page_size, parsed.orientation, parsed.margin) == ("a4", "auto", "small")


def test_explicit_values() -> None:
    parsed = parse_options(
        {"tool": "image-pdf", "pageSize": "letter", "orientation": "landscape", "margin": "none"}
    )
    assert parsed == ImagePdfOptions(page_size="letter", orientation="landscape", margin="none")
    fit = parse_options({"tool": "image-pdf", "pageSize": "fit", "margin": "medium"})
    assert fit == ImagePdfOptions(page_size="fit", orientation="auto", margin="medium")


@pytest.mark.parametrize(
    "bad",
    [
        {"pageSize": "a3"},
        {"pageSize": None},
        {"pageSize": 4},
        {"orientation": "diagonal"},
        {"orientation": None},
        {"margin": "huge"},
        {"margin": 12},
        {"format": "pdf"},
        {"pageSize": "fit", "orientation": "portrait"},
        {"pageSize": "fit", "orientation": "landscape"},
    ],
)
def test_invalid_options(bad: dict[str, object]) -> None:
    with pytest.raises(ProtocolError):
        parse_options({"tool": "image-pdf", **bad})


def test_limits_default_and_optional() -> None:
    limits = parse_limits(DEFAULT_LIMITS)
    assert limits.image_pdf_max_images == 30
    assert limits.image_pdf_max_input_bytes == 104_857_600
    custom = parse_limits({**DEFAULT_LIMITS, "imagePdfMaxImages": 2, "imagePdfMaxInputBytes": 9})
    assert (custom.image_pdf_max_images, custom.image_pdf_max_input_bytes) == (2, 9)
    with pytest.raises(ProtocolError):
        parse_limits({**DEFAULT_LIMITS, "imagePdfMaxImages": 0})
    with pytest.raises(ProtocolError):
        parse_limits({**DEFAULT_LIMITS, "imagePdfMaxImages": True})


def test_request_has_exactly_one_result_without_level(tmp_path: Path) -> None:
    source, target = tmp_path / "in.zip", tmp_path / "out.pdf"
    options = {"tool": "image-pdf", "pageSize": "fit"}
    parsed = parse_request(encode(request(source, options, [(new_id(), None, target)])))
    assert isinstance(parsed.options, ImagePdfOptions)
    with pytest.raises(ProtocolError):
        parse_request(encode(request(source, options, [(new_id(), "high", target)])))
    with pytest.raises(ProtocolError):
        two: list[tuple[str, str | None, Path]] = [
            (new_id(), None, target),
            (new_id(), None, tmp_path / "b.pdf"),
        ]
        parse_request(encode(request(source, options, two)))
