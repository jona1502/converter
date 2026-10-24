"""Annahmekontrolle vor dem Upload: Reservierung und Speicherbudget.

Vertrag §4 Schritt 3 und §7 „Speicherbudget“:

- Vor dem Lesen des Bodys wird eine **Upload-Reservierung** angelegt und die
  maximale Eingabegröße im Speicherbudget reserviert. So können viele
  gleichzeitige Uploads das Budget nicht gemeinsam überschreiten.
- Das Budget ist eine einzige Zeile (``storage_usage``); Reservieren ist ein
  bedingtes Update ``reserved + n <= budget``. Es gibt keinen Zeitpunkt, an
  dem zwei Anfragen denselben freien Platz „sehen“.
- Die Reservierung läuft unter ``pg_advisory_xact_lock``. Dieselbe kurze
  Sperre schützt in B09 die Zählung aktiver Aufträge je Sitzung und global
  (``session-job-limit``/``server-busy``) sowie Rate-Limits; diese Grenzen
  sind in B03 noch **nicht** aktiv.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import timedelta
from typing import Final

from sqlalchemy import delete, func, insert, select, update
from sqlalchemy.orm import Session

from app.api.errors import ApiError, ApiErrorCode
from app.core.config import Settings
from app.db.engine import Database
from app.db.models import StorageUsage, UploadReservation
from app.storage.local import spool_key

# Fester Schlüssel für pg_advisory_xact_lock („conv“ als Zahl).
ADMISSION_LOCK_KEY: Final = 0x636F6E76
STORAGE_FULL_RETRY_SECONDS: Final = 60


@dataclass(frozen=True)
class Reservation:
    id: uuid.UUID
    bytes: int
    spool_key: str


def reserve_bytes(db: Session, amount: int, budget: int) -> bool:
    """Reserviert ``amount`` Bytes, wenn das Budget reicht (bedingtes Update)."""
    reserved = db.execute(
        update(StorageUsage)
        .where(StorageUsage.id == 1, StorageUsage.reserved_bytes + amount <= budget)
        .values(reserved_bytes=StorageUsage.reserved_bytes + amount)
        .returning(StorageUsage.reserved_bytes)
    ).scalar_one_or_none()
    return reserved is not None


def release_bytes(db: Session, amount: int) -> None:
    if amount <= 0:
        return
    db.execute(
        update(StorageUsage)
        .where(StorageUsage.id == 1)
        .values(reserved_bytes=StorageUsage.reserved_bytes - amount)
    )


def reserve_upload(database: Database, settings: Settings, session_id: uuid.UUID) -> Reservation:
    """Legt eine Upload-Reservierung an oder wirft ``503 storage-full``."""
    amount = settings.max_upload_input_bytes
    reservation_id = uuid.uuid4()
    key = spool_key(reservation_id)
    with database.session() as db, db.begin():
        db.execute(select(func.pg_advisory_xact_lock(ADMISSION_LOCK_KEY)))
        # B09: hier aktive Aufträge + Reservierungen zählen (Sitzung/global).
        if not reserve_bytes(db, amount, settings.storage_budget_bytes):
            raise ApiError(
                ApiErrorCode.STORAGE_FULL,
                503,
                "Speicherbudget erschöpft.",
                retry_after=STORAGE_FULL_RETRY_SECONDS,
            )
        db.execute(
            insert(UploadReservation).values(
                id=reservation_id,
                session_id=session_id,
                bytes=amount,
                spool_key=key,
                expires_at=func.now() + timedelta(seconds=settings.upload_max_seconds),
            )
        )
    return Reservation(id=reservation_id, bytes=amount, spool_key=key)


def take_reservation(db: Session, reservation_id: uuid.UUID) -> int | None:
    """Entfernt die Reservierung und liefert ihre Bytes (None, falls schon weg).

    Wer die Zeile löscht, ist für die Bytes verantwortlich – API und Cleanup
    können so nie doppelt freigeben.
    """
    amount: int | None = db.execute(
        delete(UploadReservation)
        .where(UploadReservation.id == reservation_id)
        .returning(UploadReservation.bytes)
    ).scalar_one_or_none()
    return amount


def release_reservation(database: Database, reservation_id: uuid.UUID) -> None:
    with database.session() as db, db.begin():
        amount = take_reservation(db, reservation_id)
        if amount is not None:
            release_bytes(db, amount)
