"""Gemeinsame Fixtures."""

from __future__ import annotations

import pytest

from converter.limits import Limits


@pytest.fixture
def limits() -> Limits:
    return Limits()
