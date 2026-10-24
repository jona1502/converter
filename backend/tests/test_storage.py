"""Privater Storage: interne Schlüssel, atomarer Transfer und Bereinigung."""

from __future__ import annotations

import os
import uuid
from pathlib import Path

import pytest

from app.storage.local import InvalidStorageKeyError, LocalStorage, input_key, spool_key


@pytest.mark.parametrize(
    "key",
    [
        "../secret",
        "/etc/passwd",
        "spool/../secret",
        "jobs/../../secret",
        "spool/not-a-uuid",
        "jobs/" + str(uuid.uuid4()) + "/../../secret",
    ],
)
def test_user_paths_are_rejected(tmp_path: Path, key: str) -> None:
    storage = LocalStorage(tmp_path)
    with pytest.raises(InvalidStorageKeyError):
        storage.create(key)


def test_promote_preserves_bytes_and_removes_spool(tmp_path: Path) -> None:
    storage = LocalStorage(tmp_path)
    source, target = spool_key(uuid.uuid4()), input_key(uuid.uuid4())
    writer = storage.create(source)
    writer.write(b"first")
    writer.write(b"second")
    writer.close()
    storage.promote(source, target)
    assert not storage.exists(source)
    assert storage.path_for(target).read_bytes() == b"firstsecond"
    if os.name != "nt":
        assert storage.path_for(target).stat().st_mode & 0o777 == 0o600
        assert storage.path_for(target).parent.stat().st_mode & 0o777 == 0o700
    storage.delete(target)
    storage.delete(target)
    assert not storage.exists(target)


def test_discard_closes_and_removes_partial_file(tmp_path: Path) -> None:
    storage = LocalStorage(tmp_path)
    key = spool_key(uuid.uuid4())
    writer = storage.create(key)
    writer.write(b"partial")
    writer.discard()
    assert not storage.exists(key)
    with pytest.raises(ValueError, match="geschlossen"):
        writer.write(b"more")
