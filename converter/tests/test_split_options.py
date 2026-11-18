"""Optionen von pdf-split: strenge Union, Modus und Bereichsangabe."""

from __future__ import annotations

import pytest

from converter.errors import ProtocolError
from converter.options import SplitOptions, parse_options


def test_each_mode_has_no_ranges() -> None:
    options = parse_options({"tool": "pdf-split", "mode": "each"})
    assert options == SplitOptions(mode="each")
    assert not options.single_pdf


def test_ranges_mode_parses_ranges() -> None:
    options = parse_options({"tool": "pdf-split", "mode": "ranges", "ranges": "1-3,5,7-"})
    assert isinstance(options, SplitOptions)
    assert options.ranges == ((1, 3), (5, 5), (7, None))
    assert not options.single_pdf


def test_single_range_yields_single_pdf() -> None:
    options = parse_options({"tool": "pdf-split", "mode": "ranges", "ranges": "2-4"})
    assert isinstance(options, SplitOptions)
    assert options.single_pdf


@pytest.mark.parametrize(
    "value",
    [
        {"tool": "pdf-split"},
        {"tool": "pdf-split", "mode": "all"},
        {"tool": "pdf-split", "mode": None},
        {"tool": "pdf-split", "mode": "ranges"},
        {"tool": "pdf-split", "mode": "ranges", "ranges": ""},
        {"tool": "pdf-split", "mode": "ranges", "ranges": "3-1"},
        {"tool": "pdf-split", "mode": "ranges", "ranges": "1, 2"},
        {"tool": "pdf-split", "mode": "ranges", "ranges": 3},
        {"tool": "pdf-split", "mode": "each", "ranges": "1"},
        {"tool": "pdf-split", "mode": "each", "levels": []},
        {"tool": "pdf-split", "mode": "each", "extra": True},
    ],
)
def test_invalid_options_are_rejected(value: dict[str, object]) -> None:
    with pytest.raises(ProtocolError) as caught:
        parse_options(value)
    assert caught.value.code == "invalid-options"
