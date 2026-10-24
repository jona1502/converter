"""Anonyme Sitzung, Cookie-Attribute und Schutz schreibender Anfragen (§3)."""

from __future__ import annotations

from http.cookies import SimpleCookie

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import select, text

from app.core.config import Settings
from app.core.security import csrf_token, hash_token
from app.db.engine import Database
from app.db.models import AnonymousSession
from app.factory import create_app
from tests.conftest import TEST_ORIGIN, TEST_SECRET
from tests.helpers import PNG_BYTES, ApiClient, job_body


def _cookie(header: str) -> SimpleCookie:
    cookie: SimpleCookie = SimpleCookie()
    cookie.load(header)
    return cookie


def test_session_is_created_with_local_cookie(api: ApiClient, database: Database) -> None:
    response = api.client.get("/api/v1/session")
    assert response.status_code == 200
    body = response.json()
    assert body["created"] is True
    assert body["expiresAt"].endswith("Z")

    morsel = _cookie(response.headers["set-cookie"])["converter_session"]
    assert morsel["httponly"] is True
    assert morsel["samesite"] == "strict"
    assert morsel["path"] == "/"
    assert not morsel["secure"]
    assert int(morsel["max-age"]) == 86_400
    token = morsel.value

    # In der DB steht nur der Hash, nie das Token selbst.
    with database.session() as db:
        stored = db.execute(select(AnonymousSession.token_hash)).scalars().all()
        dump = db.execute(text("SELECT row_to_json(s)::text FROM sessions s")).scalar_one()
    assert stored == [hash_token(token)]
    assert token not in dump
    assert body["csrfToken"] == csrf_token(TEST_SECRET, hash_token(token))


def test_existing_session_is_reused(api: ApiClient) -> None:
    first = api.start_session()
    second = api.client.get("/api/v1/session").json()
    assert second["created"] is False
    assert second["csrfToken"] == first["csrfToken"]


def test_invalid_or_unknown_cookie_creates_new_session(api: ApiClient) -> None:
    api.client.cookies.set("converter_session", "x" * 43)
    body = api.client.get("/api/v1/session").json()
    assert body["created"] is True


def test_secure_cookie_uses_host_prefix(db_settings: Settings) -> None:
    settings = db_settings.model_copy(update={"session_cookie_secure": True})
    app = create_app(settings)
    try:
        with TestClient(app, base_url="https://testserver") as client:
            response = client.get("/api/v1/session")
    finally:
        app.state.database.dispose()
    morsel = _cookie(response.headers["set-cookie"])["__Host-converter_session"]
    assert morsel["secure"] is True
    assert morsel["path"] == "/"
    assert not morsel["domain"]


def test_expired_session_is_rejected(api: ApiClient, database: Database) -> None:
    api.start_session()
    with database.engine.begin() as connection:
        connection.execute(text("UPDATE sessions SET expires_at = now() - interval '1 second'"))
    response = api.post_job(job_body({"tool": "pdf-compress"}, PNG_BYTES))
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "session-required"
    assert api.client.get("/api/v1/session").json()["created"] is True


def test_session_slides_on_use(api: ApiClient, database: Database) -> None:
    api.start_session()
    with database.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE sessions SET expires_at = now() + interval '1 hour', "
                "last_seen_at = now() - interval '2 hours'"
            )
        )
    api.client.get("/api/v1/jobs/00000000-0000-4000-8000-000000000000")
    with database.engine.connect() as connection:
        remaining = connection.execute(
            text("SELECT extract(epoch FROM expires_at - now()) FROM sessions")
        ).scalar_one()
    assert remaining > 23 * 3600


# --- Schreibschutz ----------------------------------------------------------


def test_write_without_session_is_401(api: ApiClient) -> None:
    response = api.post_job(job_body({"tool": "pdf-compress"}, PNG_BYTES))
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "session-required"


@pytest.mark.parametrize(
    "headers",
    [
        {"X-CSRF-Token": ""},
        {"X-CSRF-Token": "falsch"},
        {"Origin": "https://evil.example"},
        {"Origin": "null"},
    ],
    ids=["csrf-missing", "csrf-wrong", "foreign-origin", "null-origin"],
)
def test_write_with_bad_csrf_or_origin_is_403(api: ApiClient, headers: dict[str, str]) -> None:
    api.start_session()
    response = api.post_job(job_body({"tool": "pdf-compress"}, PNG_BYTES), headers=headers)
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "csrf-failed"


def test_missing_origin_with_cross_site_fetch_metadata_is_403(api: ApiClient) -> None:
    api.start_session()
    headers = api.write_headers(**{"Sec-Fetch-Site": "cross-site"})
    del headers["Origin"]
    response = api.client.delete(
        "/api/v1/jobs/00000000-0000-4000-8000-000000000000", headers=headers
    )
    assert response.status_code == 403


def test_missing_origin_same_origin_is_allowed(api: ApiClient) -> None:
    api.start_session()
    headers = api.write_headers(**{"Sec-Fetch-Site": "same-origin"})
    del headers["Origin"]
    response = api.client.delete(
        "/api/v1/jobs/00000000-0000-4000-8000-000000000000", headers=headers
    )
    # Schutz bestanden; der Auftrag existiert nur nicht.
    assert response.status_code == 404


def test_csrf_token_of_other_session_is_rejected(db_settings: Settings, api: ApiClient) -> None:
    api.start_session()
    other_app = create_app(db_settings)
    try:
        with TestClient(other_app) as other_client:
            other = ApiClient(other_client)
            other.start_session()
            response = api.post_job(
                job_body({"tool": "pdf-compress"}, PNG_BYTES),
                headers={"X-CSRF-Token": other.csrf or ""},
            )
    finally:
        other_app.state.database.dispose()
    assert response.status_code == 403


def test_csrf_depends_on_secret_key(db_settings: Settings, api: ApiClient) -> None:
    api.start_session()
    rotated = db_settings.model_copy(
        update={"secret_key": SecretStr("another-secret-key-0123456789abcdefghij")}
    )
    app = create_app(rotated)
    try:
        with TestClient(app, cookies=api.client.cookies) as client:
            response = client.delete(
                "/api/v1/jobs/00000000-0000-4000-8000-000000000000",
                headers={"X-CSRF-Token": api.csrf or "", "Origin": TEST_ORIGIN},
            )
    finally:
        app.state.database.dispose()
    assert response.status_code == 403
