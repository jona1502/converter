"""Alembic-Umgebung.

URL-Quelle (in dieser Reihenfolge):
1. ``config.attributes["database_url"]`` – von Tests programmatisch gesetzt,
2. ``CONVERTER_DATABASE_URL`` über die App-Settings.

Aufruf: ``uv run alembic upgrade head`` (im Verzeichnis ``backend``).
"""

from __future__ import annotations

import os

from alembic import context
from sqlalchemy import create_engine, pool

from app.db.engine import normalize_database_url
from app.db.models import Base

config = context.config
target_metadata = Base.metadata


def _database_url() -> str:
    url = config.attributes.get("database_url")
    if isinstance(url, str) and url:
        return normalize_database_url(url)
    # Settings() würde für Migrationen unnötig SECRET_KEY usw. verlangen;
    # hier zählt nur die Datenbank-URL.
    env_url = os.environ.get("CONVERTER_DATABASE_URL")
    if not env_url:
        raise RuntimeError("CONVERTER_DATABASE_URL ist nicht gesetzt")
    return normalize_database_url(env_url)


def run_migrations_offline() -> None:
    context.configure(
        url=_database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = create_engine(_database_url(), poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()
    engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
