"""Gemeinsame Test-Fixtures."""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.core.config import Settings
from app.factory import create_app

TEST_SECRET = "test-secret-key-0123456789abcdefghijklmnop"


@pytest.fixture(autouse=True)
def _isolate_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keine CONVERTER_*-Variablen des Entwicklerrechners in Tests übernehmen."""
    for name in list(os.environ):
        if name.startswith("CONVERTER_"):
            monkeypatch.delenv(name)


@pytest.fixture
def storage_dir(tmp_path: Path) -> Path:
    path = tmp_path / "storage"
    path.mkdir()
    return path


@pytest.fixture
def settings(storage_dir: Path) -> Settings:
    return Settings(environment="test", secret_key=SecretStr(TEST_SECRET), storage_dir=storage_dir)


@pytest.fixture
def app(settings: Settings) -> FastAPI:
    return create_app(settings)


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    with TestClient(app, raise_server_exceptions=False) as test_client:
        yield test_client
