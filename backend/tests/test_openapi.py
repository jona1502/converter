"""OpenAPI-Schema: Ablageort, Drift und Doku nur außerhalb von production."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.core.config import Settings
from app.factory import create_app
from scripts.export_openapi import OPENAPI_PATH, render_openapi
from tests.conftest import TEST_SECRET


def test_committed_openapi_is_up_to_date() -> None:
    assert OPENAPI_PATH.read_text(encoding="utf-8") == render_openapi(), (
        "api/openapi.json ist veraltet: `uv run python scripts/export_openapi.py`"
    )


def test_openapi_documents_error_format(client: TestClient) -> None:
    schema = client.get("/api/v1/openapi.json").json()
    assert "/api/v1/health/ready" in schema["paths"]
    error_detail = schema["components"]["schemas"]["ErrorDetail"]
    assert set(error_detail["properties"]) == {"code", "message", "retryAfterSeconds", "fields"}
    assert "HTTPValidationError" not in schema["components"]["schemas"]


def test_docs_available_outside_production(client: TestClient) -> None:
    assert client.get("/api/v1/docs").status_code == 200


def test_docs_disabled_in_production(tmp_path: Path) -> None:
    settings = Settings(
        environment="production",
        database_url=SecretStr("postgresql://converter:converter@localhost/converter_test"),
        secret_key=SecretStr(TEST_SECRET),
        allowed_origins=["https://converter.example"],
        storage_dir=tmp_path,
    )
    client = TestClient(create_app(settings))
    assert client.get("/api/v1/docs").status_code == 404
    assert client.get("/api/v1/openapi.json").status_code == 200
