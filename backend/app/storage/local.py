"""Privater Dateispeicher auf einem lokalen Verzeichnis (Docker-Volume).

Regeln (Vertrag §7):

- Dateien werden nur über interne Schlüssel angesprochen
  (``spool/<id>``, ``jobs/<job_id>/input``,
  ``jobs/<job_id>/results/<result_id>/<lease_token>``). Benutzereingaben wie
  Dateinamen landen nie in einem Pfad.
- Verzeichnisse ``0700``, Dateien ``0600``.
- Fertige Dateien entstehen atomar: erst vollständig schreiben und mit
  ``fsync`` sichern, dann per ``os.replace`` an den Zielort verschieben.

``Storage`` ist die austauschbare Schnittstelle (z. B. später S3);
``LocalStorage`` die einzige Implementierung.
"""

from __future__ import annotations

import contextlib
import os
import re
import uuid
from pathlib import Path
from typing import Final, Protocol, Self

_UUID: Final = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
_KEY_PATTERN: Final = re.compile(
    rf"spool/{_UUID}|jobs/{_UUID}(/input|/results/{_UUID}/{_UUID})?",
)

DIR_MODE: Final = 0o700
FILE_MODE: Final = 0o600


class InvalidStorageKeyError(ValueError):
    """Schlüssel entspricht keinem erlaubten Muster (z. B. Pfadmanipulation)."""


def spool_key(reservation_id: uuid.UUID) -> str:
    return f"spool/{reservation_id}"


def job_key(job_id: uuid.UUID) -> str:
    return f"jobs/{job_id}"


def input_key(job_id: uuid.UUID) -> str:
    return f"jobs/{job_id}/input"


def result_key(job_id: uuid.UUID, result_id: uuid.UUID, lease_token: uuid.UUID) -> str:
    return f"jobs/{job_id}/results/{result_id}/{lease_token}"


def validate_key(key: str) -> str:
    if not _KEY_PATTERN.fullmatch(key):
        raise InvalidStorageKeyError("ungültiger Speicherschlüssel")
    return key


class SpoolWriter(Protocol):
    """Schreibt eine neue Datei; erst ``close()`` macht sie dauerhaft."""

    def write(self, data: bytes) -> None: ...
    def close(self) -> None: ...
    def discard(self) -> None: ...


class Storage(Protocol):
    def create(self, key: str) -> SpoolWriter: ...
    def promote(self, source_key: str, target_key: str) -> None: ...
    def delete(self, key: str) -> None: ...
    def exists(self, key: str) -> bool: ...


class _LocalWriter:
    def __init__(self, path: Path) -> None:
        self._path = path
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        self._fd: int | None = os.open(path, flags, FILE_MODE)

    def write(self, data: bytes) -> None:
        if self._fd is None:
            raise ValueError("Datei ist bereits geschlossen")
        view = memoryview(data)
        while view:
            written = os.write(self._fd, view)
            view = view[written:]

    def close(self) -> None:
        if self._fd is None:
            return
        fd, self._fd = self._fd, None
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def discard(self) -> None:
        if self._fd is not None:
            fd, self._fd = self._fd, None
            os.close(fd)
        self._path.unlink(missing_ok=True)

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *exc: object) -> None:
        self.discard() if exc[0] is not None else self.close()


def _fsync_dir(path: Path) -> None:
    # Unter POSIX macht erst das fsync des Verzeichnisses ein rename dauerhaft.
    # Windows (nur Entwicklung) kann Verzeichnisse nicht öffnen.
    if os.name == "nt":
        return
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


class LocalStorage:
    def __init__(self, root: Path) -> None:
        self.root = root

    def path_for(self, key: str) -> Path:
        """Absoluter Pfad zu einem Schlüssel; nur innerhalb von ``root``."""
        path = self.root.joinpath(*validate_key(key).split("/"))
        # Zweite Verteidigungslinie gegen Symlinks im Speicherverzeichnis.
        root = self.root.resolve()
        if not path.resolve().is_relative_to(root):
            raise InvalidStorageKeyError("Schlüssel verlässt das Speicherverzeichnis")
        return path

    def _ensure_parent(self, path: Path) -> None:
        missing: list[Path] = []
        parent = path.parent
        while parent != self.root and not parent.exists():
            missing.append(parent)
            parent = parent.parent
        for directory in reversed(missing):
            with contextlib.suppress(FileExistsError):
                directory.mkdir(mode=DIR_MODE)
            directory.chmod(DIR_MODE)  # mkdir-Modus wird durch die umask gefiltert
            _fsync_dir(directory.parent)

    def create(self, key: str) -> _LocalWriter:
        path = self.path_for(key)
        self._ensure_parent(path)
        return _LocalWriter(path)

    def promote(self, source_key: str, target_key: str) -> None:
        source = self.path_for(source_key)
        target = self.path_for(target_key)
        self._ensure_parent(target)
        source.replace(target)
        _fsync_dir(target.parent)
        if source.parent != target.parent:
            _fsync_dir(source.parent)

    def delete(self, key: str) -> None:
        self.path_for(key).unlink(missing_ok=True)

    def exists(self, key: str) -> bool:
        return self.path_for(key).is_file()
