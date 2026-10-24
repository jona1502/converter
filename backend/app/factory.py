"""App-Factory: baut eine vollständig konfigurierte FastAPI-Anwendung.

Eine Factory statt einer globalen App erlaubt Tests, beliebig viele Apps mit
eigener Konfiguration (z. B. eigenem Storage-Verzeichnis) zu erzeugen.
"""

from __future__ import annotations

from fastapi import FastAPI

from app.api import API_PREFIX, health
from app.api.errors import INTERNAL_ERROR_RESPONSE, install_error_handlers
from app.api.middleware import RequestContextMiddleware
from app.core.config import Settings
from app.core.logs import configure_logging
from app.core.readiness import ReadinessRegistry
from app.storage.checks import storage_writable_check


def build_readiness(settings: Settings) -> ReadinessRegistry:
    registry = ReadinessRegistry(timeout_seconds=settings.health_check_timeout_seconds)
    registry.register("storage", storage_writable_check(settings.storage_dir))
    # Ab B03/B04/B05: "database", "redis", "capabilities".
    return registry


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings if settings is not None else Settings()
    configure_logging(settings.log_level)

    app = FastAPI(
        title="MI converter API",
        version="1.0.0",
        openapi_url=f"{API_PREFIX}/openapi.json",
        # Interaktive Doku nur in Entwicklung/Test; das Schema bleibt abrufbar.
        docs_url=None if settings.is_production else f"{API_PREFIX}/docs",
        redoc_url=None,
    )
    app.state.settings = settings
    app.state.readiness = build_readiness(settings)

    install_error_handlers(app)
    app.add_middleware(RequestContextMiddleware)
    # Jeder Endpunkt kann 500 internal-error liefern (siehe middleware.py).
    app.include_router(health.router, responses=INTERNAL_ERROR_RESPONSE)
    return app
