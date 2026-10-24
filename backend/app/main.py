"""Einstiegspunkt für uvicorn: ``uvicorn app.main:app``.

Die Konfiguration wird beim Import aus den ``CONVERTER_*``-Umgebungsvariablen
gelesen. Tests und Skripte importieren ``create_app`` aus ``app.factory``,
damit kein Import dieses Moduls eine App mit Umgebungskonfiguration baut.
"""

from __future__ import annotations

from app.factory import create_app

__all__ = ["app"]

app = create_app()
