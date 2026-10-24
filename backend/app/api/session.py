"""``GET /api/v1/session``: anonyme Sitzung anlegen oder erneuern (Vertrag §3)."""

from __future__ import annotations

from fastapi import APIRouter, Request, Response

from app.api import API_PREFIX
from app.api.auth import cookie_name, create_session, optional_session
from app.api.deps import DatabaseDep, SettingsDep
from app.core.security import csrf_token
from app.schemas.session import SessionResponse

router = APIRouter(prefix=API_PREFIX, tags=["session"])


@router.get("/session", summary="Anonyme Sitzung anlegen oder erneuern")
def get_session(
    request: Request, response: Response, database: DatabaseDep, settings: SettingsDep
) -> SessionResponse:
    """Liefert das CSRF-Token für schreibende Anfragen.

    Das Cookie wird bei jedem Aufruf neu gesetzt (Max-Age = Sitzungsdauer),
    damit Browser- und Serverablauf zusammenpassen. Das Neuanlage-Limit je
    Client-IP folgt in B09.
    """
    session = optional_session(request, database, settings)
    if session is None:
        with database.session() as db, db.begin():
            session = create_session(db, settings)
    response.set_cookie(
        cookie_name(settings),
        session.token,
        max_age=settings.session_ttl_seconds,
        path="/",
        secure=settings.session_cookie_secure,
        httponly=True,
        samesite="strict",
    )
    return SessionResponse(
        csrf_token=csrf_token(settings.effective_secret_key, session.token_hash),
        expires_at=session.expires_at,
        created=session.created,
    )
