"""Antwort von ``GET /api/v1/session``."""

from __future__ import annotations

from app.schemas.base import ApiModel, UtcDatetime


class SessionResponse(ApiModel):
    csrf_token: str
    expires_at: UtcDatetime
    created: bool
