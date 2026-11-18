"""Seitenbereichs-Syntax gegen die gemeinsamen Vektoren (Go, Python, TypeScript)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from converter.processing.split import ranges

VECTORS = Path(__file__).resolve().parents[2] / "api" / "page-range-vectors.json"
data = json.loads(VECTORS.read_text(encoding="utf-8")) if VECTORS.exists() else None
pytestmark = pytest.mark.skipif(
    data is None, reason="api/page-range-vectors.json fehlt im Build-Kontext"
)


def test_limits_match_vectors() -> None:
    assert data is not None
    assert data["maxPageNumber"] == ranges.MAX_PAGE_NUMBER
    assert data["maxRanges"] == ranges.MAX_RANGES
    assert data["maxLength"] == ranges.MAX_LENGTH


def test_valid_vectors() -> None:
    assert data is not None
    for case in data["valid"]:
        expected = tuple((start, end) for start, end in case["ranges"])
        assert ranges.parse_ranges(case["input"]) == expected, case["input"]


def test_invalid_vectors() -> None:
    assert data is not None
    for value in data["invalid"]:
        with pytest.raises(ValueError):
            ranges.parse_ranges(value)


def test_count_and_length_limits() -> None:
    assert len(ranges.parse_ranges(",".join(["1"] * ranges.MAX_RANGES))) == ranges.MAX_RANGES
    with pytest.raises(ValueError):
        ranges.parse_ranges(",".join(["1"] * (ranges.MAX_RANGES + 1)))
    with pytest.raises(ValueError):
        ranges.parse_ranges("1-" + "0" * ranges.MAX_LENGTH)
