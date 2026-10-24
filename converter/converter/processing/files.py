"""Zugriff auf die von Go vorab angelegten Ergebnisdateien.

Der Konverter erzeugt keine Dateien und folgt keinen Symlinks: Go legt jede
Ergebnisdatei exklusiv (``O_EXCL``, ``0600``) an, der Konverter öffnet sie nur
zum Überschreiben. Gescheiterte Ergebnisse werden geleert, nicht gelöscht;
das Entfernen bleibt Aufgabe von Go.
"""

from __future__ import annotations

import contextlib
import os
from pathlib import Path

_FLAGS = (
    os.O_WRONLY
    | os.O_TRUNC
    | getattr(os, "O_NOFOLLOW", 0)
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_BINARY", 0)
)


def open_result(path: Path) -> int:
    """Öffnet eine vorhandene Ergebnisdatei zum Schreiben (ohne O_CREAT)."""
    return os.open(path, _FLAGS)


def discard(path: Path) -> None:
    """Leert eine teilweise geschriebene Ergebnisdatei (best effort)."""
    with contextlib.suppress(OSError):
        os.close(open_result(path))
