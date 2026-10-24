"""Gemeinsame FastAPI-Abhängigkeiten: Settings, Datenbank, Speicher.

Alles hängt an ``app.state`` (gesetzt in ``create_app``), damit Tests eigene
Apps mit eigener Konfiguration bauen können.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Request

from app.api.errors import ApiError, ApiErrorCode
from app.core.config import Settings
from app.db.engine import Database
from app.storage.local import LocalStorage


def get_settings(request: Request) -> Settings:
    settings = request.app.state.settings
    if not isinstance(settings, Settings):
        raise TypeError("app.state.settings fehlt")
    return settings


def get_database(request: Request) -> Database:
    database = getattr(request.app.state, "database", None)
    if not isinstance(database, Database):
        # Ohne CONVERTER_DATABASE_URL (nur Entwicklung/Test) gibt es keine
        # Aufträge; production verlangt die URL (Settings-Validierung).
        raise ApiError(ApiErrorCode.SERVICE_UNAVAILABLE, 503, "Datenbank nicht konfiguriert.")
    return database


def get_storage(request: Request) -> LocalStorage:
    storage = request.app.state.storage
    if not isinstance(storage, LocalStorage):
        raise TypeError("app.state.storage fehlt")
    return storage


SettingsDep = Annotated[Settings, Depends(get_settings)]
DatabaseDep = Annotated[Database, Depends(get_database)]
StorageDep = Annotated[LocalStorage, Depends(get_storage)]
