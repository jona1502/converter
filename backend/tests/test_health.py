from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.core.config import Settings
from app.core.readiness import ReadinessRegistry
from app.factory import create_app
from tests.conftest import TEST_SECRET


def _client_for(storage_dir: Path) -> TestClient:
    settings = Settings(
        environment="test", secret_key=SecretStr(TEST_SECRET), storage_dir=storage_dir
    )
    return TestClient(create_app(settings))


def test_live_returns_ok(client: TestClient) -> None:
    response = client.get("/api/v1/health/live")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_ready_reports_registered_checks_only(client: TestClient, storage_dir: Path) -> None:
    response = client.get("/api/v1/health/ready")
    assert response.status_code == 200
    # B02 registriert nur "storage"; database/redis/capabilities folgen später.
    assert response.json() == {"status": "ok", "checks": {"storage": "ok"}}
    assert list(storage_dir.iterdir()) == [], "Prüfdatei muss wieder gelöscht sein"


def test_ready_is_503_when_storage_dir_missing(tmp_path: Path) -> None:
    response = _client_for(tmp_path / "does-not-exist").get("/api/v1/health/ready")
    assert response.status_code == 503
    assert response.json() == {"status": "unavailable", "checks": {"storage": "fail"}}


def test_ready_is_503_when_storage_path_is_a_file(tmp_path: Path) -> None:
    not_a_dir = tmp_path / "file"
    not_a_dir.write_bytes(b"x")
    response = _client_for(not_a_dir).get("/api/v1/health/ready")
    assert response.status_code == 503
    assert response.json()["checks"] == {"storage": "fail"}


@pytest.mark.skipif(
    sys.platform == "win32" or (hasattr(os, "geteuid") and os.geteuid() == 0),
    reason="Verzeichnisrechte greifen nur unter POSIX und nicht für root",
)
def test_ready_is_503_when_storage_dir_read_only(storage_dir: Path) -> None:
    storage_dir.chmod(0o500)
    try:
        response = _client_for(storage_dir).get("/api/v1/health/ready")
    finally:
        storage_dir.chmod(0o700)
    assert response.status_code == 503
    assert response.json()["checks"] == {"storage": "fail"}


def _registry(app: FastAPI) -> ReadinessRegistry:
    registry = app.state.readiness
    assert isinstance(registry, ReadinessRegistry)
    return registry


def test_failing_check_does_not_leak_details(app: FastAPI, client: TestClient) -> None:
    def broken() -> bool:
        raise RuntimeError("db.internal:5432 password=hunter2")

    _registry(app).register("database", broken)
    response = client.get("/api/v1/health/ready")
    assert response.status_code == 503
    assert response.json() == {
        "status": "unavailable",
        "checks": {"database": "fail", "storage": "ok"},
    }
    assert "hunter2" not in response.text
    assert "5432" not in response.text


def test_check_returning_false_fails(app: FastAPI, client: TestClient) -> None:
    _registry(app).register("redis", lambda: False)
    response = client.get("/api/v1/health/ready")
    assert response.status_code == 503
    assert response.json()["checks"]["redis"] == "fail"


def test_slow_check_times_out(storage_dir: Path) -> None:
    settings = Settings(
        environment="test",
        secret_key=SecretStr(TEST_SECRET),
        storage_dir=storage_dir,
        health_check_timeout_seconds=0.1,
    )
    app = create_app(settings)
    release = threading.Event()

    def hangs() -> bool:
        release.wait(5)
        return True

    _registry(app).register("redis", hangs)
    try:
        response = TestClient(app).get("/api/v1/health/ready")
    finally:
        release.set()
    assert response.status_code == 503
    assert response.json()["checks"] == {"redis": "fail", "storage": "ok"}


def test_hanging_check_does_not_start_more_threads(storage_dir: Path) -> None:
    settings = Settings(
        environment="test",
        secret_key=SecretStr(TEST_SECRET),
        storage_dir=storage_dir,
        health_check_timeout_seconds=0.1,
    )
    app = create_app(settings)
    release = threading.Event()
    calls = 0

    def hangs_until_released() -> bool:
        nonlocal calls
        calls += 1
        release.wait(5)
        return True

    _registry(app).register("redis", hangs_until_released)
    client = TestClient(app)
    try:
        for _ in range(3):
            response = client.get("/api/v1/health/ready")
            assert response.json()["checks"]["redis"] == "fail"
        # Nur der erste Aufruf hat einen Thread gestartet; die folgenden
        # schlagen sofort fehl, solange er hängt.
        assert calls == 1
    finally:
        release.set()
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        response = client.get("/api/v1/health/ready")
        if response.status_code == 200:
            break
        time.sleep(0.05)
    assert response.json()["checks"] == {"redis": "ok", "storage": "ok"}
    assert calls >= 2


def test_duplicate_check_name_is_rejected() -> None:
    registry = ReadinessRegistry(timeout_seconds=1)
    registry.register("storage", lambda: True)
    with pytest.raises(ValueError, match="bereits registriert"):
        registry.register("storage", lambda: True)
