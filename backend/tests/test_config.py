"""Konfiguration: Vertragsstartwerte und Produktionsvalidierung."""

from __future__ import annotations

import ipaddress
from typing import Any

import pytest
from pydantic import SecretStr, ValidationError

from app.core.config import Settings
from tests.conftest import TEST_SECRET

PRODUCTION: dict[str, Any] = {
    "environment": "production",
    "database_url": SecretStr("postgresql://converter:converter@localhost/converter_test"),
    "secret_key": SecretStr(TEST_SECRET),
    "allowed_origins": ["https://converter.example"],
}


def test_defaults_match_contract_limits() -> None:
    s = Settings(environment="test")
    assert s.image_max_input_bytes == 52_428_800
    assert (s.image_max_pixels, s.image_max_edge) == (40_000_000, 16_384)
    assert s.image_max_output_bytes == 104_857_600
    assert s.pdf_max_input_bytes == 100_000_000
    assert s.pdf_max_results_total_bytes == 300_000_000
    assert s.pdf_image_max_pixels == 40_000_000
    assert s.job_ttl_seconds == 3600
    assert (s.session_max_active_jobs, s.global_max_active_jobs) == (3, 50)
    assert (s.session_creates_per_minute, s.ip_creates_per_minute) == (10, 10)
    assert (s.image_timeout_seconds, s.pdf_timeout_seconds) == (120, 300)
    assert s.storage_budget_bytes == 5_000_000_000
    assert s.cleanup_interval_seconds == 60
    assert s.download_max_seconds == 300
    assert s.physical_delete_max_seconds == 600
    assert s.upload_concurrency == 2
    assert s.job_max_attempts == 3
    assert s.session_ttl_seconds == 86_400
    assert s.session_cookie_secure is True


def test_default_environment_is_production_and_strict() -> None:
    # Ohne jede Konfiguration greift die strenge Produktionsprüfung.
    with pytest.raises(ValidationError, match="secret_key ist in production Pflicht"):
        Settings()


def test_valid_production_settings() -> None:
    s = Settings(**PRODUCTION)
    assert s.is_production
    assert s.effective_secret_key == TEST_SECRET


@pytest.mark.parametrize(
    ("override", "message"),
    [
        ({"secret_key": None}, "secret_key ist in production Pflicht"),
        ({"secret_key": SecretStr("zu-kurz")}, "mindestens 32 Zeichen"),
        ({"session_cookie_secure": False}, "session_cookie_secure"),
        ({"allowed_origins": []}, "allowed_origins ist in production Pflicht"),
    ],
)
def test_production_rejects_unsafe_settings(override: dict[str, Any], message: str) -> None:
    with pytest.raises(ValidationError, match=message):
        Settings(**{**PRODUCTION, **override})


def test_reads_environment_with_prefix_and_csv_lists(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CONVERTER_ENVIRONMENT", "production")
    monkeypatch.setenv(
        "CONVERTER_DATABASE_URL", "postgresql://converter:converter@localhost/converter_test"
    )
    monkeypatch.setenv("CONVERTER_SECRET_KEY", TEST_SECRET)
    monkeypatch.setenv(
        "CONVERTER_ALLOWED_ORIGINS", "https://Converter.example, http://localhost:4321"
    )
    monkeypatch.setenv("CONVERTER_TRUSTED_PROXIES", "10.0.0.0/8,::1")
    monkeypatch.setenv("CONVERTER_IMAGE_MAX_INPUT_BYTES", "1000")
    monkeypatch.setenv("CONVERTER_LOG_LEVEL", "debug")
    s = Settings()
    assert s.allowed_origins == ["https://converter.example", "http://localhost:4321"]
    assert s.trusted_proxies == [
        ipaddress.ip_network("10.0.0.0/8"),
        ipaddress.ip_network("::1/128"),
    ]
    assert s.image_max_input_bytes == 1000
    assert s.log_level == "DEBUG"


@pytest.mark.parametrize(
    "origin",
    ["converter.example", "https://converter.example/path", "ftp://x", "https://u@host"],
)
def test_invalid_origins_are_rejected(origin: str) -> None:
    with pytest.raises(ValidationError, match="allowed_origins"):
        Settings(environment="test", allowed_origins=[origin])


def test_invalid_proxy_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CONVERTER_TRUSTED_PROXIES", "not-an-ip")
    with pytest.raises(ValidationError):
        Settings(environment="test")


def test_limits_must_be_positive() -> None:
    with pytest.raises(ValidationError):
        Settings(environment="test", image_max_input_bytes=0)


def test_development_without_secret_uses_stable_ephemeral_key() -> None:
    s = Settings(environment="development", session_cookie_secure=False)
    key = s.effective_secret_key
    assert len(key) >= 32
    assert s.effective_secret_key == key
    assert Settings(environment="development").effective_secret_key != key


def test_secrets_are_not_exposed_in_repr() -> None:
    s = Settings(**{**PRODUCTION, "database_url": SecretStr("postgresql://u:pw-secret@db/x")})
    assert TEST_SECRET not in repr(s)
    assert "pw-secret" not in repr(s)


@pytest.mark.parametrize(
    "extra_env",
    [
        {"CONVERTER_SECRET_KEY": "kurz-abc-secret"},  # zu kurz
        {"CONVERTER_SECRET_KEY": TEST_SECRET},  # allowed_origins fehlt
        {"CONVERTER_SECRET_KEY": TEST_SECRET, "CONVERTER_IMAGE_MAX_INPUT_BYTES": "-1"},
    ],
)
def test_validation_errors_do_not_contain_secrets(
    monkeypatch: pytest.MonkeyPatch, extra_env: dict[str, str]
) -> None:
    monkeypatch.setenv("CONVERTER_ENVIRONMENT", "production")
    monkeypatch.setenv(
        "CONVERTER_DATABASE_URL", "postgresql://converter:converter@localhost/converter_test"
    )
    monkeypatch.setenv("CONVERTER_DATABASE_URL", "postgresql://u:pw-secret@db/x")
    monkeypatch.setenv("CONVERTER_REDIS_URL", "redis://:redis-secret@redis:6379/0")
    for name, value in extra_env.items():
        monkeypatch.setenv(name, value)
    with pytest.raises(ValidationError) as excinfo:
        Settings()
    # Was typischerweise geloggt oder angezeigt wird: str/repr der Ausnahme.
    text = str(excinfo.value) + repr(excinfo.value)
    for secret in ("kurz-abc-secret", TEST_SECRET, "pw-secret", "redis-secret"):
        assert secret not in text
