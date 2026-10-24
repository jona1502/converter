"""Health-Endpunkte für Container-Healthcheck und Orchestrierung."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response, status

from app.api import API_PREFIX
from app.core.readiness import ReadinessRegistry
from app.schemas.health import LiveResponse, ReadyResponse

router = APIRouter(prefix=f"{API_PREFIX}/health", tags=["health"])


def get_readiness(request: Request) -> ReadinessRegistry:
    registry = request.app.state.readiness
    if not isinstance(registry, ReadinessRegistry):
        raise TypeError("app.state.readiness fehlt")
    return registry


@router.get("/live", summary="Prozess antwortet")
async def live() -> LiveResponse:
    """Prüft keine Abhängigkeiten – nur, ob der Prozess Anfragen beantwortet."""
    return LiveResponse()


@router.get(
    "/ready",
    summary="Benötigte Abhängigkeiten erreichbar",
    responses={
        503: {"model": ReadyResponse, "description": "Mindestens eine Prüfung fehlgeschlagen"},
    },
)
async def ready(
    response: Response,
    registry: Annotated[ReadinessRegistry, Depends(get_readiness)],
) -> ReadyResponse:
    checks = await registry.run()
    healthy = all(result == "ok" for result in checks.values())
    if not healthy:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return ReadyResponse(status="ok" if healthy else "unavailable", checks=checks)
