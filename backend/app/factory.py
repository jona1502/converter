"""App-Factory: baut eine vollständig konfigurierte FastAPI-Anwendung.

Eine Factory statt einer globalen App erlaubt Tests, beliebig viele Apps mit
eigener Konfiguration (z. B. eigenem Storage-Verzeichnis) zu erzeugen.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI

from app.api import API_PREFIX, health, jobs, session
from app.api.errors import INTERNAL_ERROR_RESPONSE, install_error_handlers
from app.api.middleware import RequestContextMiddleware
from app.core.config import Settings
from app.core.logs import configure_logging
from app.core.readiness import ReadinessRegistry
from app.db.engine import Database, database_check
from app.schemas.options import JOB_OPTIONS_ADAPTER
from app.storage.checks import storage_writable_check
from app.storage.local import LocalStorage


def build_readiness(settings: Settings, database: Database | None) -> ReadinessRegistry:
    registry = ReadinessRegistry(timeout_seconds=settings.health_check_timeout_seconds)
    registry.register("storage", storage_writable_check(settings.storage_dir))
    if database is not None:
        registry.register("database", database_check(database))
    # Ab B04/B05: "redis", "capabilities".
    return registry


def _install_openapi(app: FastAPI) -> None:
    """Ergänzt das Schema um ``JobOptions`` (Inhalt des Multipart-Teils
    ``options``), damit das Frontend die Typen daraus generieren kann."""

    def openapi() -> dict[str, Any]:
        if app.openapi_schema:
            return app.openapi_schema
        schema = FastAPI.openapi(app)
        options_schema = JOB_OPTIONS_ADAPTER.json_schema(
            by_alias=True, ref_template="#/components/schemas/{model}"
        )
        components = schema.setdefault("components", {}).setdefault("schemas", {})
        components.update(options_schema.pop("$defs", {}))
        components["JobOptions"] = options_schema
        app.openapi_schema = schema
        return schema

    app.openapi = openapi  # type: ignore[method-assign]


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings if settings is not None else Settings()
    configure_logging(settings.log_level)

    database = (
        Database(settings.database_url.get_secret_value(), pool_size=settings.database_pool_size)
        if settings.database_url is not None
        else None
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        yield
        if database is not None:
            database.dispose()

    app = FastAPI(
        title="MI converter API",
        version="1.0.0",
        openapi_url=f"{API_PREFIX}/openapi.json",
        # Interaktive Doku nur in Entwicklung/Test; das Schema bleibt abrufbar.
        docs_url=None if settings.is_production else f"{API_PREFIX}/docs",
        redoc_url=None,
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.database = database
    app.state.storage = LocalStorage(settings.storage_dir)
    app.state.readiness = build_readiness(settings, database)

    install_error_handlers(app)
    app.add_middleware(RequestContextMiddleware)
    # Jeder Endpunkt kann 500 internal-error liefern (siehe middleware.py).
    for router in (health.router, session.router, jobs.router):
        app.include_router(router, responses=INTERNAL_ERROR_RESPONSE)
    _install_openapi(app)
    return app
