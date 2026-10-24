"""Fehlerformat nach Vertrag Abschnitt 2 für alle Fehlerquellen."""

from __future__ import annotations

import json
import uuid
from collections.abc import Iterator
from typing import Annotated

import pytest
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient
from pydantic import BaseModel, ConfigDict, Field

from app.api.errors import (
    MAX_FIELD_ERRORS,
    MAX_FIELD_PATH_LENGTH,
    ApiError,
    ApiErrorCode,
    FieldError,
)
from app.core.logs import JsonFormatter


class _Options(BaseModel):
    model_config = ConfigDict(extra="forbid")
    quality: int = Field(ge=1, le=100)


@pytest.fixture
def error_client(app: FastAPI) -> TestClient:
    @app.get("/api/v1/_test/needs-int")
    async def needs_int(count: Annotated[int, Query()]) -> dict[str, int]:
        return {"count": count}

    @app.post("/api/v1/_test/options")
    async def options(body: _Options) -> dict[str, int]:
        return {"quality": body.quality}

    @app.get("/api/v1/_test/busy")
    async def busy() -> None:
        raise ApiError(ApiErrorCode.SERVER_BUSY, 503, "Annahmegrenze erreicht.", retry_after=12)

    @app.get("/api/v1/_test/invalid-options")
    async def invalid_options() -> None:
        raise ApiError(
            ApiErrorCode.INVALID_OPTIONS,
            422,
            "Optionen ungültig.",
            fields=[FieldError(path="options.width", code="out-of-range")],
        )

    @app.get("/api/v1/_test/crash")
    async def crash() -> None:
        raise RuntimeError("geheim: /srv/storage/jobs/abc password=hunter2")

    @app.post("/api/v1/_test/many")
    async def many(body: dict[str, _Options]) -> dict[str, int]:
        return {"count": len(body)}

    @app.get("/api/v1/_test/http/{code}")
    async def http_error(code: int) -> None:
        raise HTTPException(status_code=code, detail="DETAILTEXT /srv/geheim db.internal")

    @app.get("/api/v1/_test/stream-crash")
    async def stream_crash() -> StreamingResponse:
        def chunks() -> Iterator[bytes]:
            yield b"erster-teil"
            raise RuntimeError("geheim nach Antwortbeginn")

        return StreamingResponse(chunks(), media_type="application/octet-stream")

    return TestClient(app, raise_server_exceptions=False)


def _assert_envelope(body: dict[str, object], request_id: str) -> None:
    assert set(body) == {"error", "requestId"}
    assert body["requestId"] == request_id


def test_unknown_route_returns_not_found(error_client: TestClient) -> None:
    response = error_client.get("/api/v1/does-not-exist")
    assert response.status_code == 404
    body = response.json()
    _assert_envelope(body, response.headers["x-request-id"])
    assert body["error"] == {"code": "not-found", "message": "Ressource nicht gefunden."}


def test_wrong_method_returns_method_not_allowed(error_client: TestClient) -> None:
    response = error_client.post("/api/v1/health/live")
    assert response.status_code == 405
    assert response.json()["error"]["code"] == "method-not-allowed"
    assert response.headers["allow"] == "GET"


def test_query_validation_error(error_client: TestClient) -> None:
    response = error_client.get("/api/v1/_test/needs-int", params={"count": "secret-value"})
    assert response.status_code == 422
    body = response.json()
    _assert_envelope(body, response.headers["x-request-id"])
    assert body["error"] == {
        "code": "invalid-request",
        "message": "Anfrage ist ungültig.",
        "fields": [{"path": "query.count", "code": "int-parsing"}],
    }
    assert "secret-value" not in response.text


def test_body_validation_error_lists_paths_without_values(error_client: TestClient) -> None:
    response = error_client.post(
        "/api/v1/_test/options", json={"quality": 1000, "sneaky": "top-secret"}
    )
    assert response.status_code == 422
    fields = response.json()["error"]["fields"]
    assert sorted(fields, key=lambda f: f["path"]) == [
        # Unbekannte Schlüssel ohne den vom Client gewählten Namen.
        {"path": "body", "code": "unknown-field"},
        {"path": "quality", "code": "out-of-range"},
    ]
    assert "sneaky" not in response.text
    assert "1000" not in response.text
    assert "top-secret" not in response.text


def test_malformed_json_is_invalid_request(error_client: TestClient) -> None:
    response = error_client.post(
        "/api/v1/_test/options",
        content=b'{"quality": ',
        headers={"content-type": "application/json"},
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid-request"


def test_api_error_with_retry_after(error_client: TestClient) -> None:
    response = error_client.get("/api/v1/_test/busy")
    assert response.status_code == 503
    assert response.headers["retry-after"] == "12"
    assert response.json()["error"] == {
        "code": "server-busy",
        "message": "Annahmegrenze erreicht.",
        "retryAfterSeconds": 12,
    }


def test_api_error_with_fields(error_client: TestClient) -> None:
    response = error_client.get("/api/v1/_test/invalid-options")
    assert response.status_code == 422
    assert response.json()["error"]["fields"] == [{"path": "options.width", "code": "out-of-range"}]
    assert "retry-after" not in response.headers


def test_unhandled_exception_returns_internal_error_without_details(
    error_client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    response = error_client.get("/api/v1/_test/crash")
    assert response.status_code == 500
    request_id = response.headers["x-request-id"]
    assert uuid.UUID(request_id)
    assert response.json() == {
        "error": {"code": "internal-error", "message": "Interner Fehler."},
        "requestId": request_id,
    }
    for leaked in ("Traceback", "RuntimeError", "hunter2", "/srv/storage"):
        assert leaked not in response.text
    # Ausnahme wird serverseitig geloggt – Typ und Stack, ohne Meldungstext.
    errors = [r for r in caplog.records if r.exc_info and r.levelname == "ERROR"]
    assert len(errors) == 1
    line = JsonFormatter().format(errors[0])
    entry = json.loads(line)
    assert entry["exceptionType"] == "RuntimeError"
    assert entry["requestId"] == request_id
    assert any("in crash" in frame for frame in entry["stack"])
    assert "hunter2" not in line
    assert "/srv/storage" not in line
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"


def test_field_errors_are_limited_in_count_and_length(error_client: TestClient) -> None:
    long_key = "k" * 500
    payload = {f"{i}-{long_key}": {"quality": 0} for i in range(50)}
    response = error_client.post("/api/v1/_test/many", json=payload)
    assert response.status_code == 422
    fields = response.json()["error"]["fields"]
    assert len(fields) == MAX_FIELD_ERRORS
    assert all(len(f["path"]) <= MAX_FIELD_PATH_LENGTH for f in fields)
    assert len(response.content) < 4096


@pytest.mark.parametrize(
    ("status_code", "expected_status", "expected_code"),
    [
        (400, 400, "invalid-request"),
        (409, 409, "invalid-request"),
        (502, 500, "internal-error"),
        (503, 503, "service-unavailable"),
    ],
)
def test_http_exception_detail_is_not_exposed(
    error_client: TestClient, status_code: int, expected_status: int, expected_code: str
) -> None:
    response = error_client.get(f"/api/v1/_test/http/{status_code}")
    assert response.status_code == expected_status
    assert response.json()["error"]["code"] == expected_code
    assert "DETAILTEXT" not in response.text
    assert "/srv/geheim" not in response.text


def test_exception_after_response_start_is_logged_and_aborted(
    error_client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    # Nach Antwortbeginn kann kein 500 mehr gesendet werden: Status bleibt
    # 200, der Body bricht ab, die Ausnahme wird ohne Meldung geloggt.
    response = error_client.get("/api/v1/_test/stream-crash")
    assert response.status_code == 200
    assert response.headers["x-request-id"]
    assert "geheim" not in response.text
    errors = [r for r in caplog.records if r.exc_info and r.levelname == "ERROR"]
    assert errors
    line = JsonFormatter().format(errors[0])
    assert json.loads(line)["exceptionType"] == "RuntimeError"
    assert "geheim" not in line
