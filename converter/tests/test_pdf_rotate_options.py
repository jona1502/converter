"""Optionen und Seitenlisten für pdf-rotate."""

from __future__ import annotations

import pytest

from converter.errors import ProtocolError
from converter.options import parse_options
from converter.rotate_options import PdfRotateOptions, parse_page_ranges


def test_defaults_to_all_pages() -> None:
    assert parse_options({"tool": "pdf-rotate", "angle": 90}) == PdfRotateOptions(angle=90)


def test_full_options() -> None:
    options = parse_options({"tool": "pdf-rotate", "angle": 270, "pages": "1-3,5"})
    assert options == PdfRotateOptions(angle=270, pages="1-3,5")


@pytest.mark.parametrize(
    "value",
    [
        {"tool": "pdf-rotate"},
        {"tool": "pdf-rotate", "angle": 0},
        {"tool": "pdf-rotate", "angle": 45},
        {"tool": "pdf-rotate", "angle": -90},
        {"tool": "pdf-rotate", "angle": 90.0},
        {"tool": "pdf-rotate", "angle": True},
        {"tool": "pdf-rotate", "angle": "90"},
        {"tool": "pdf-rotate", "angle": 90, "pages": ""},
        {"tool": "pdf-rotate", "angle": 90, "pages": "0"},
        {"tool": "pdf-rotate", "angle": 90, "pages": "3-1"},
        {"tool": "pdf-rotate", "angle": 90, "pages": "1,,2"},
        {"tool": "pdf-rotate", "angle": 90, "pages": "1 - 2"},
        {"tool": "pdf-rotate", "angle": 90, "pages": "-2"},
        {"tool": "pdf-rotate", "angle": 90, "pages": "ALL"},
        {"tool": "pdf-rotate", "angle": 90, "pages": 1},
        {"tool": "pdf-rotate", "angle": 90, "pages": "1" * 300},
        {"tool": "pdf-rotate", "angle": 90, "levels": []},
    ],
)
def test_rejects_invalid_options(value: dict[str, object]) -> None:
    with pytest.raises(ProtocolError) as exc:
        parse_options(value)
    assert exc.value.code == "invalid-options"


def test_page_ranges() -> None:
    assert parse_page_ranges("7") == [(7, 7)]
    assert parse_page_ranges("1-3,5,9-10") == [(1, 3), (5, 5), (9, 10)]
