"""PDF zu Bild: Optionen, Seitenauswahl und Grenzen (reine Protokollebene)."""

from __future__ import annotations

from pathlib import Path

import pytest

from converter.errors import ProtocolError
from converter.limits import parse_limits
from converter.options import PdfImageOptions, parse_options
from converter.pagespec import normalize_pages, parse_pages
from tests.helpers import DEFAULT_LIMITS


def test_defaults_and_full_options() -> None:
    parsed = parse_options({"tool": "pdf-to-image", "format": "png"})
    assert parsed == PdfImageOptions(format="png", dpi=150, pages=None, quality=0.85)
    full = parse_options(
        {"tool": "pdf-to-image", "format": "webp", "dpi": 300, "pages": "1-3,5", "quality": 0.5}
    )
    assert full == PdfImageOptions(format="webp", dpi=300, pages=(1, 2, 3, 5), quality=0.5)
    assert parse_options({"tool": "pdf-to-image", "format": "jpeg", "pages": "all"}).pages is None  # type: ignore[union-attr]


@pytest.mark.parametrize(
    "bad",
    [
        {},
        {"format": "gif"},
        {"format": None},
        {"format": "png", "dpi": 71},
        {"format": "png", "dpi": 301},
        {"format": "png", "dpi": 150.0},
        {"format": "png", "dpi": True},
        {"format": "png", "dpi": "150"},
        {"format": "png", "pages": ""},
        {"format": "png", "pages": 3},
        {"format": "png", "pages": "0"},
        {"format": "png", "pages": "2-1"},
        {"format": "png", "pages": "1, 2"},
        {"format": "png", "pages": "a"},
        {"format": "png", "quality": 1.5},
        {"format": "png", "quality": float("nan")},
        {"format": "png", "quality": "0.5"},
        {"format": "png", "unknown": 1},
        {"format": "png", "levels": ["high"]},
    ],
)
def test_invalid_options_are_rejected(bad: dict[str, object]) -> None:
    with pytest.raises(ProtocolError) as exc:
        parse_options({"tool": "pdf-to-image", **bad})
    assert exc.value.code == "invalid-options"


@pytest.mark.parametrize(
    ("text", "pages"),
    [
        ("1", (1,)),
        ("3,1,2", (1, 2, 3)),
        ("1-3,2-5", (1, 2, 3, 4, 5)),
        ("7,7,7", (7,)),
        ("10-10", (10,)),
        ("9999", (9999,)),
    ],
)
def test_page_selection_is_sorted_and_unique(text: str, pages: tuple[int, ...]) -> None:
    assert parse_pages(text) == pages


def test_all_means_every_page() -> None:
    assert parse_pages("all") is None


@pytest.mark.parametrize(
    "text",
    [
        "",
        " ",
        "0",
        "-1",
        "1-",
        "-",
        "1--2",
        "3-2",
        "1,,2",
        "1,",
        ",1",
        "1 2",
        "٣",
        "10000",
        "1e3",
        "1" * 201,
        "ALL",
        "all,1",
    ],
)
def test_bad_page_selection_is_rejected(text: str) -> None:
    with pytest.raises(ValueError, match="pages"):
        parse_pages(text)


@pytest.mark.parametrize(
    ("pages", "text"),
    [
        ((1,), "1"),
        ((1, 2, 3, 5), "1-3,5"),
        ((1, 3, 5), "1,3,5"),
        ((4, 5), "4-5"),
        ((1, 2, 4, 5, 6, 9), "1-2,4-6,9"),
    ],
)
def test_normalized_text_is_canonical(pages: tuple[int, ...], text: str) -> None:
    assert normalize_pages(pages) == text
    assert parse_pages(text) == pages


def test_render_limits_have_defaults_and_overrides() -> None:
    assert parse_limits(DEFAULT_LIMITS).pdf_render_max_pages == 100
    assert parse_limits({**DEFAULT_LIMITS, "pdfRenderMaxPages": 5}).pdf_render_max_pages == 5
    with pytest.raises(ProtocolError):
        parse_limits({**DEFAULT_LIMITS, "pdfRenderMaxPages": 0})
    with pytest.raises(ProtocolError):
        parse_limits({**DEFAULT_LIMITS, "pdfRenderMaxPages": True})


def test_request_needs_exactly_one_result_without_level(tmp_path: Path) -> None:
    from converter.protocol import parse_request
    from tests.helpers import encode, new_id, request

    options = {"tool": "pdf-to-image", "format": "png"}
    good = request(tmp_path / "in.pdf", options, [(new_id(), None, tmp_path / "out.png")])
    parsed = parse_request(encode(good))
    assert isinstance(parsed.options, PdfImageOptions)
    leveled = request(tmp_path / "in.pdf", options, [(new_id(), "high", tmp_path / "out.png")])
    with pytest.raises(ProtocolError):
        parse_request(encode(leveled))
