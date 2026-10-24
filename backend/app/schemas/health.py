"""Antwortmodelle der Health-Endpunkte (Vertrag Abschnitt 4)."""

from __future__ import annotations

from typing import Literal

from app.core.readiness import CheckStatus
from app.schemas.base import ApiModel


class LiveResponse(ApiModel):
    status: Literal["ok"] = "ok"


class ReadyResponse(ApiModel):
    status: Literal["ok", "unavailable"]
    # Nur registrierte Prüfungen erscheinen; keine Hostnamen oder Fehlertexte.
    checks: dict[str, CheckStatus]
