"""Anonyme Sitzung und Schutz schreibender Anfragen (Vertrag §3).

Abhängigkeiten für Endpunkte:

- ``CurrentSessionDep``: gültige Sitzung aus dem Cookie, sonst
  ``401 session-required``. Verlängert die Sitzung gleitend.
- ``WriteSessionDep``: zusätzlich ``X-CSRF-Token`` und Origin-Prüfung, sonst
  ``403 csrf-failed``. Für alle ``POST``/``DELETE``.

Die Abhängigkeiten sind synchron (``def``); FastAPI führt sie in einem
Thread aus, die Datenbankzugriffe blockieren also nicht die Event-Loop.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy import func, insert, select, update
from sqlalchemy.orm import Session

from app.api.deps import DatabaseDep, SettingsDep
from app.api.errors import ApiError, ApiErrorCode
from app.core.config import Settings
from app.core.security import (
    csrf_matches,
    csrf_token,
    hash_token,
    is_plausible_token,
    new_session_token,
)
from app.db.models import AnonymousSession

# Gleitende Verlängerung höchstens einmal pro Minute schreiben, damit
# Status-Polling (etwa 1/s) nicht bei jeder Anfrage die Zeile aktualisiert.
TOUCH_INTERVAL = timedelta(seconds=60)
CSRF_HEADER = "x-csrf-token"


def cookie_name(settings: Settings) -> str:
    # __Host- verlangt Secure, Path=/ und keine Domain; lokal über HTTP geht
    # das nicht, daher dort bewusst ein anderer Name (Vertrag §3).
    return "__Host-converter_session" if settings.session_cookie_secure else "converter_session"


@dataclass(frozen=True)
class CurrentSession:
    id: uuid.UUID
    token: str
    token_hash: bytes
    expires_at: datetime
    created: bool = False


def _ttl(settings: Settings) -> timedelta:
    return timedelta(seconds=settings.session_ttl_seconds)


def find_session(db: Session, token: str, settings: Settings) -> CurrentSession | None:
    """Gültige Sitzung zum Token laden und ggf. gleitend verlängern."""
    if not is_plausible_token(token):
        return None
    token_hash = hash_token(token)
    now = func.now()
    touched = db.execute(
        update(AnonymousSession)
        .where(
            AnonymousSession.token_hash == token_hash,
            AnonymousSession.expires_at > now,
            AnonymousSession.last_seen_at < now - TOUCH_INTERVAL,
        )
        .values(last_seen_at=now, expires_at=now + _ttl(settings))
        .returning(AnonymousSession.id, AnonymousSession.expires_at)
    ).one_or_none()
    row = (
        touched
        or db.execute(
            select(AnonymousSession.id, AnonymousSession.expires_at).where(
                AnonymousSession.token_hash == token_hash, AnonymousSession.expires_at > now
            )
        ).one_or_none()
    )
    if row is None:
        return None
    return CurrentSession(id=row[0], token=token, token_hash=token_hash, expires_at=row[1])


def create_session(db: Session, settings: Settings) -> CurrentSession:
    token = new_session_token()
    token_hash = hash_token(token)
    session_id = uuid.uuid4()
    expires_at = db.execute(
        insert(AnonymousSession)
        .values(id=session_id, token_hash=token_hash, expires_at=func.now() + _ttl(settings))
        .returning(AnonymousSession.expires_at)
    ).scalar_one()
    return CurrentSession(
        id=session_id, token=token, token_hash=token_hash, expires_at=expires_at, created=True
    )


def optional_session(
    request: Request, database: DatabaseDep, settings: SettingsDep
) -> CurrentSession | None:
    token = request.cookies.get(cookie_name(settings))
    if not token:
        return None
    with database.session() as db, db.begin():
        return find_session(db, token, settings)


def require_session(
    request: Request, database: DatabaseDep, settings: SettingsDep
) -> CurrentSession:
    session = optional_session(request, database, settings)
    if session is None:
        raise ApiError(ApiErrorCode.SESSION_REQUIRED, 401, "Gültige Sitzung erforderlich.")
    return session


CurrentSessionDep = Annotated[CurrentSession, Depends(require_session)]


def origin_allowed(request: Request, settings: Settings) -> bool:
    origin = request.headers.get("origin")
    if origin is not None:
        return origin.lower() in settings.allowed_origins
    # Ohne Origin (ältere Browser, manche Same-Origin-Anfragen): Fetch-Metadata.
    return request.headers.get("sec-fetch-site", "").lower() != "cross-site"


def require_write_access(
    request: Request, session: CurrentSessionDep, settings: SettingsDep
) -> CurrentSession:
    expected = csrf_token(settings.effective_secret_key, session.token_hash)
    if not csrf_matches(expected, request.headers.get(CSRF_HEADER)):
        raise ApiError(ApiErrorCode.CSRF_FAILED, 403, "CSRF-Prüfung fehlgeschlagen.")
    if not origin_allowed(request, settings):
        raise ApiError(ApiErrorCode.CSRF_FAILED, 403, "Origin nicht erlaubt.")
    return session


WriteSessionDep = Annotated[CurrentSession, Depends(require_write_access)]
