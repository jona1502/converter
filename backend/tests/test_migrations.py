"""Alembic: leere Datenbank → head, erneutes Anwenden, Modelle = Schema."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url

from app.db.models import Base
from tests.conftest import TEST_DATABASE_URL, alembic_config, recreate_database

MIGRATION_DB_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=f"{make_url(TEST_DATABASE_URL).database}_migrations")
    .render_as_string(hide_password=False)
)


@pytest.fixture
def empty_database() -> Iterator[str]:
    recreate_database(MIGRATION_DB_URL)
    yield MIGRATION_DB_URL


def test_upgrade_from_empty_database_and_again(empty_database: str) -> None:
    config = alembic_config(empty_database)
    command.upgrade(config, "head")
    # Zweiter Lauf auf bestehender Datenbank ist ein No-op.
    command.upgrade(config, "head")

    engine = create_engine(empty_database)
    try:
        with engine.connect() as connection:
            tables = set(inspect(connection).get_table_names())
            assert {
                "sessions",
                "jobs",
                "job_results",
                "outbox",
                "upload_reservations",
                "storage_usage",
                "alembic_version",
            } <= tables
            usage = connection.execute(text("SELECT id, reserved_bytes FROM storage_usage")).all()
            assert [tuple(row) for row in usage] == [(1, 0)]
            # Modelle und migriertes Schema stimmen überein.
            diff = compare_metadata(MigrationContext.configure(connection), Base.metadata)
            assert diff == []
    finally:
        engine.dispose()


def test_downgrade_to_base_and_upgrade_again(empty_database: str) -> None:
    config = alembic_config(empty_database)
    command.upgrade(config, "head")
    command.downgrade(config, "base")
    command.upgrade(config, "head")
