"""Request-ID, Sicherheitsheader und Zugriffslog."""

from __future__ import annotations

import json
import logging
import uuid
from pathlib import Path

import pytest
from fastapi import FastAPI, Response
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.core.config import Settings
from app.core.logs import JsonFormatter
from app.factory import create_app
from tests.conftest import TEST_SECRET


def _is_uuid(value: str) -> bool:
    try:
        uuid.UUID(value)
    except ValueError:
        return False
    return True


def test_valid_request_id_is_adopted(client: TestClient) -> None:
    response = client.get("/api/v1/health/live", headers={"X-Request-Id": "proxy-1234-abcd"})
    assert response.headers["x-request-id"] == "proxy-1234-abcd"


@pytest.mark.parametrize(
    "incoming",
    [
        "short",  # zu kurz
        "a" * 65,  # zu lang
        "abc_def_ghi",  # Unterstrich nicht erlaubt
        "abcdefgh\tx",  # Steuerzeichen
        "abcdefgh ijk",  # Leerzeichen
        "ünicode-1234",  # Nicht-ASCII (als UTF-8-Bytes gesendet)
    ],
)
def test_invalid_request_id_is_replaced(client: TestClient, incoming: str) -> None:
    raw = incoming.encode()
    response = client.get("/api/v1/health/live", headers={b"X-Request-Id": raw})
    generated = response.headers["x-request-id"]
    assert generated.encode() != raw
    assert _is_uuid(generated)


def test_request_id_generated_when_missing(client: TestClient) -> None:
    first = client.get("/api/v1/health/live").headers["x-request-id"]
    second = client.get("/api/v1/health/live").headers["x-request-id"]
    assert _is_uuid(first)
    assert first != second


@pytest.mark.parametrize("path", ["/api/v1/health/live", "/api/v1/unknown", "/api/v1/openapi.json"])
def test_security_headers_on_api_responses(client: TestClient, path: str) -> None:
    response = client.get(path)
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"


def test_explicit_cache_control_is_kept(app: FastAPI) -> None:
    # Downloads setzen später "private, no-store" selbst; das darf bleiben.
    @app.get("/api/v1/_test/download")
    async def download() -> Response:
        return Response(b"x", headers={"Cache-Control": "private, no-store"})

    response = TestClient(app).get("/api/v1/_test/download")
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["x-content-type-options"] == "nosniff"


def test_access_log_is_structured_and_omits_secrets(
    client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG, logger="app.request")
    client.cookies.set("converter_session", "cookie-secret-value")
    response = client.get(
        "/api/v1/health/live?name=Geheim.pdf",
        headers={"X-Request-Id": "trace-abcdef12", "X-CSRF-Token": "csrf-secret-value"},
    )
    assert response.status_code == 200

    records = [r for r in caplog.records if r.name == "app.request"]
    assert len(records) == 1
    line = JsonFormatter().format(records[0])
    entry = json.loads(line)
    assert entry["requestId"] == "trace-abcdef12"
    # Erfolgreiche Health-Abfragen (Container-Healthcheck) nur auf DEBUG.
    assert entry["level"] == "DEBUG"
    assert entry["method"] == "GET"
    assert entry["route"] == "/api/v1/health/live"
    assert entry["status"] == 200
    assert isinstance(entry["durationMs"], float)
    for secret in ("cookie-secret-value", "csrf-secret-value", "Geheim.pdf"):
        assert secret not in line


def test_unmatched_route_is_not_logged_verbatim(
    client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO, logger="app.request")
    client.get("/api/v1/jobs/Urlaubsfoto-Anna.jpg")
    record = next(r for r in caplog.records if r.name == "app.request")
    assert record.levelno == logging.INFO
    line = JsonFormatter().format(record)
    assert json.loads(line)["route"] == "unmatched"
    assert "Urlaubsfoto" not in line


def test_json_formatter_drops_unknown_extra_fields() -> None:
    record = logging.LogRecord("x", logging.INFO, __file__, 1, "msg", None, None)
    record.__dict__["cookie"] = "nope"
    record.__dict__["status"] = 201
    entry = json.loads(JsonFormatter().format(record))
    assert "cookie" not in entry
    assert entry["status"] == 201


def test_failed_readiness_is_logged_at_info(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG, logger="app.request")
    settings = Settings(
        environment="test", secret_key=SecretStr(TEST_SECRET), storage_dir=tmp_path / "missing"
    )
    TestClient(create_app(settings)).get("/api/v1/health/ready")
    records = [r for r in caplog.records if r.name == "app.request"]
    assert [r.levelno for r in records] == [logging.INFO]
