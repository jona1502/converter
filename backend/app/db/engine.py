"""Datenbankverbindung (synchrones SQLAlchemy 2 mit psycopg 3).

Warum synchron? Dieselben Modelle und Transaktionsfunktionen nutzt ab B04
auch der Celery-Worker, der ohnehin synchron arbeitet. Async-Endpunkte (der
Upload) rufen die Funktionen über einen Thread auf (``anyio.to_thread``),
damit die Event-Loop nicht blockiert.

Jede Funktion, die schreibt, öffnet ihre eigene kurze Transaktion. Es gibt
bewusst keine Sitzung, die über einen ganzen Request lebt: Ein Upload kann
Minuten dauern und darf so lange keine Datenbankverbindung belegen.
"""

from __future__ import annotations

from collections.abc import Callable

from sqlalchemy import Engine, create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session, sessionmaker


def normalize_database_url(url: str) -> str:
    """``postgresql://`` → ``postgresql+psycopg://`` (psycopg 3 statt psycopg2)."""
    parsed = make_url(url)
    if parsed.drivername in {"postgresql", "postgres"}:
        parsed = parsed.set(drivername="postgresql+psycopg")
    return parsed.render_as_string(hide_password=False)


class Database:
    def __init__(self, url: str, *, pool_size: int = 5, connect_timeout: int = 5) -> None:
        self.engine: Engine = create_engine(
            normalize_database_url(url),
            pool_size=pool_size,
            max_overflow=pool_size,
            pool_pre_ping=True,
            connect_args={"connect_timeout": connect_timeout},
        )
        # expire_on_commit=False: Objekte bleiben nach dem Commit lesbar, z. B.
        # um daraus die Antwort zu bauen.
        self.sessions: sessionmaker[Session] = sessionmaker(self.engine, expire_on_commit=False)

    def session(self) -> Session:
        return self.sessions()

    def dispose(self) -> None:
        self.engine.dispose()


def database_check(database: Database) -> Callable[[], bool]:
    """Readiness-Prüfung: Verbindung aufbauen und ``SELECT 1`` ausführen."""

    def check() -> bool:
        with database.engine.connect() as connection:
            return bool(connection.execute(text("SELECT 1")).scalar_one() == 1)

    return check
