"""Gemeinsame Test-Fixtures.

Datenbanktests laufen gegen eine echte PostgreSQL (kein SQLite), Standard
ist der Compose-Dienst ``db`` auf ``127.0.0.1:55432``. Die Testdatenbank
(Standard ``converter_test``) wird pro Testlauf neu angelegt und per Alembic
migriert. Ist PostgreSQL nicht erreichbar, schlagen die Tests mit klarer
Meldung fehl – sie werden nicht stillschweigend übersprungen.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import OperationalError

from app.core.config import Settings
from app.db.engine import Database, normalize_database_url
from app.factory import create_app
from tests.helpers import ApiClient

TEST_SECRET = "test-secret-key-0123456789abcdefghijklmnop"
TEST_ORIGIN = "http://testserver"
BACKEND_DIR = Path(__file__).resolve().parent.parent

# Beim Import lesen: die autouse-Fixture unten entfernt alle CONVERTER_*-Variablen.
TEST_DATABASE_URL = normalize_database_url(
    os.environ.get(
        "CONVERTER_TEST_DATABASE_URL",
        "postgresql://converter:converter@127.0.0.1:55432/converter_test",
    )
)


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


# --- PostgreSQL ------------------------------------------------------------------


def alembic_config(database_url: str) -> Config:
    config = Config(str(BACKEND_DIR / "alembic.ini"))
    config.attributes["database_url"] = database_url
    return config


def recreate_database(database_url: str) -> None:
    """Legt die Testdatenbank leer neu an (über die Verwaltungsdatenbank)."""
    url = make_url(database_url)
    name = url.database or ""
    if not name.replace("_", "").isalnum() or "test" not in name.lower():
        pytest.fail(f"Ungültiger Testdatenbankname: {name!r}", pytrace=False)
    admin = create_engine(url.set(database="postgres"), isolation_level="AUTOCOMMIT")
    try:
        with admin.connect() as connection:
            connection.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
            connection.execute(text(f'CREATE DATABASE "{name}"'))
    except OperationalError as exc:
        pytest.fail(
            "PostgreSQL für Tests nicht erreichbar "
            f"({url.render_as_string(hide_password=True)}): {type(exc).__name__}. "
            "Start: `docker compose up -d --wait db` oder CONVERTER_TEST_DATABASE_URL setzen.",
            pytrace=False,
        )
    finally:
        admin.dispose()


@pytest.fixture(scope="session")
def database_url() -> str:
    recreate_database(TEST_DATABASE_URL)
    command.upgrade(alembic_config(TEST_DATABASE_URL), "head")
    return TEST_DATABASE_URL


@pytest.fixture
def db_settings(storage_dir: Path, database_url: str) -> Settings:
    return Settings(
        environment="test",
        secret_key=SecretStr(TEST_SECRET),
        storage_dir=storage_dir,
        database_url=SecretStr(database_url),
        allowed_origins=[TEST_ORIGIN],
        # TestClient spricht http://testserver; Secure-Cookies würden dort
        # nicht zurückgesendet. Die Secure-Variante prüft test_session.py.
        session_cookie_secure=False,
        database_pool_size=2,
    )


def _reset(database: Database) -> None:
    with database.engine.begin() as connection:
        connection.execute(
            text(
                "TRUNCATE stale_attempts, outbox, job_results, jobs, upload_reservations, sessions "
                "RESTART IDENTITY CASCADE"
            )
        )
        connection.execute(text("UPDATE storage_usage SET reserved_bytes = 0"))


@pytest.fixture
def db_app(db_settings: Settings) -> Iterator[FastAPI]:
    app = create_app(db_settings)
    database = app.state.database
    assert isinstance(database, Database)
    _reset(database)
    yield app
    database.dispose()


@pytest.fixture
def database(db_app: FastAPI) -> Database:
    database = db_app.state.database
    assert isinstance(database, Database)
    return database


@pytest.fixture
def api(db_app: FastAPI) -> Iterator[ApiClient]:
    with TestClient(db_app, raise_server_exceptions=False) as test_client:
        yield ApiClient(test_client)
