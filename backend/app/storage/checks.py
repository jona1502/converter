"""Readiness-Prüfung für das private Dateiverzeichnis."""

from __future__ import annotations

import os
import tempfile
from collections.abc import Callable
from pathlib import Path


def storage_writable_check(storage_dir: Path) -> Callable[[], bool]:
    """Erzeugt eine Prüfung: Verzeichnis existiert und ist wirklich beschreibbar.

    ``os.access`` allein reicht nicht (z. B. bei schreibgeschützt gemounteten
    Volumes oder vollem Datenträger). Deshalb wird eine Temp-Datei angelegt,
    geschrieben, synchronisiert und sofort wieder gelöscht.
    """

    def check() -> bool:
        if not storage_dir.is_dir():
            return False
        with tempfile.NamedTemporaryFile(dir=storage_dir, prefix=".ready-", delete=True) as probe:
            probe.write(b"ok")
            probe.flush()
            os.fsync(probe.fileno())
        return True

    return check
