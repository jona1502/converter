"""Tabellen als SQLAlchemy-2-Modelle.

Das Schema wird ausschließlich über Alembic-Migrationen (``migrations/``)
angelegt. Ein Test vergleicht diese Modelle mit der migrierten Datenbank,
damit beide nicht auseinanderlaufen.

Zustände sind ``text`` mit CHECK-Constraints statt PostgreSQL-ENUMs: Neue
Werte lassen sich so ohne ``ALTER TYPE`` ergänzen, und die erlaubten Werte
stehen trotzdem in der Datenbank fest.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from datetime import datetime
from enum import StrEnum
from typing import Any

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    Integer,
    LargeBinary,
    MetaData,
    SmallInteger,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from app.jobs.domain import (
    InputFormat,
    JobPhase,
    JobState,
    OutboxKind,
    PdfLevel,
    ResultState,
    Tool,
)

# Einheitliche Constraint-Namen, damit Migrationen sie gezielt ansprechen können.
NAMING_CONVENTION = {
    "ix": "ix_%(table_name)s_%(column_0_N_name)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


def in_values(column: str, values: Iterable[StrEnum]) -> str:
    """SQL-Ausdruck ``column IN ('a', 'b')`` für CHECK-Constraints."""
    quoted = ", ".join(f"'{value.value}'" for value in values)
    return f"{column} IN ({quoted})"


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)


TIMESTAMP = DateTime(timezone=True)


class AnonymousSession(Base):
    """Anonyme Browsersitzung. Gespeichert wird nur SHA-256 des Tokens."""

    __tablename__ = "sessions"
    __table_args__ = (
        CheckConstraint("octet_length(token_hash) = 32", name="token_hash_length"),
        Index(None, "expires_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID, primary_key=True)
    token_hash: Mapped[bytes] = mapped_column(LargeBinary, unique=True)
    created_at: Mapped[datetime] = mapped_column(TIMESTAMP, server_default=func.now())
    last_seen_at: Mapped[datetime] = mapped_column(TIMESTAMP, server_default=func.now())
    expires_at: Mapped[datetime] = mapped_column(TIMESTAMP)


class Job(Base):
    __tablename__ = "jobs"
    __table_args__ = (
        CheckConstraint(in_values("tool", Tool), name="tool"),
        CheckConstraint(in_values("state", JobState), name="state"),
        CheckConstraint(f"phase IS NULL OR ({in_values('phase', JobPhase)})", name="phase"),
        CheckConstraint("phase IS NULL OR state = 'running'", name="phase_only_running"),
        CheckConstraint(in_values("input_format", InputFormat), name="input_format"),
        CheckConstraint("input_size >= 0", name="input_size"),
        CheckConstraint("octet_length(input_sha256) = 32", name="input_sha256_length"),
        CheckConstraint(
            "(idempotency_key IS NULL) = (fingerprint IS NULL)", name="idempotency_pair"
        ),
        CheckConstraint(
            "attempts >= 0 AND max_attempts >= 1 AND attempts <= max_attempts", name="attempts"
        ),
        CheckConstraint("state <> 'running' OR lease_token IS NOT NULL", name="running_lease"),
        CheckConstraint("state <> 'failed' OR error_code IS NOT NULL", name="failed_error"),
        CheckConstraint("reserved_bytes >= 0 AND working_bytes >= 0", name="bytes"),
        CheckConstraint("version >= 0", name="version"),
        # Idempotenz: ein Schlüssel je Sitzung (NULL-Schlüssel sind verschieden).
        UniqueConstraint("session_id", "idempotency_key"),
        Index(None, "expires_at"),
        Index(
            "ix_jobs_lease_expires_at_running",
            "lease_expires_at",
            postgresql_where=text("state = 'running'"),
        ),
        Index("ix_jobs_deleted_at", "deleted_at", postgresql_where=text("deleted_at IS NOT NULL")),
        Index(
            "ix_jobs_active_session",
            "session_id",
            postgresql_where=text("state IN ('queued', 'running') AND deleted_at IS NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID, primary_key=True)
    session_id: Mapped[uuid.UUID] = mapped_column(UUID, ForeignKey("sessions.id"))
    tool: Mapped[str] = mapped_column(Text)
    state: Mapped[str] = mapped_column(Text, server_default=JobState.QUEUED.value)
    phase: Mapped[str | None] = mapped_column(Text)
    options: Mapped[dict[str, Any]] = mapped_column(JSONB)

    input_name: Mapped[str] = mapped_column(Text)
    input_size: Mapped[int] = mapped_column(BigInteger)
    input_format: Mapped[str] = mapped_column(Text)
    input_sha256: Mapped[bytes] = mapped_column(LargeBinary)
    input_storage_key: Mapped[str] = mapped_column(Text)
    input_width: Mapped[int | None] = mapped_column(Integer)
    input_height: Mapped[int | None] = mapped_column(Integer)

    idempotency_key: Mapped[str | None] = mapped_column(Text)
    fingerprint: Mapped[bytes | None] = mapped_column(LargeBinary)

    # Optimistische Nebenläufigkeit: jeder Übergang erhöht version (Vertrag §5).
    version: Mapped[int] = mapped_column(Integer, server_default="0")
    attempts: Mapped[int] = mapped_column(Integer, server_default="0")
    max_attempts: Mapped[int] = mapped_column(Integer)
    lease_token: Mapped[uuid.UUID | None] = mapped_column(UUID)
    lease_expires_at: Mapped[datetime | None] = mapped_column(TIMESTAMP)
    heartbeat_at: Mapped[datetime | None] = mapped_column(TIMESTAMP)
    cancel_requested_at: Mapped[datetime | None] = mapped_column(TIMESTAMP)
    deleted_at: Mapped[datetime | None] = mapped_column(TIMESTAMP)

    created_at: Mapped[datetime] = mapped_column(TIMESTAMP, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(TIMESTAMP, server_default=func.now())
    accepted_at: Mapped[datetime] = mapped_column(TIMESTAMP, server_default=func.now())
    started_at: Mapped[datetime | None] = mapped_column(TIMESTAMP)
    finished_at: Mapped[datetime | None] = mapped_column(TIMESTAMP)
    expires_at: Mapped[datetime] = mapped_column(TIMESTAMP)

    error_code: Mapped[str | None] = mapped_column(Text)
    progress: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    analysis: Mapped[dict[str, Any] | None] = mapped_column(JSONB)

    # Speicherbudget: belegte Eingabe/Ergebnisse bzw. Arbeitsreserve (Vertrag §7).
    reserved_bytes: Mapped[int] = mapped_column(BigInteger, server_default="0")
    working_bytes: Mapped[int] = mapped_column(BigInteger, server_default="0")


class JobResult(Base):
    __tablename__ = "job_results"
    __table_args__ = (
        CheckConstraint(in_values("state", ResultState), name="state"),
        CheckConstraint(f"level IS NULL OR ({in_values('level', PdfLevel)})", name="level"),
        CheckConstraint(
            "state <> 'succeeded' OR (storage_key IS NOT NULL AND size IS NOT NULL)",
            name="succeeded_has_file",
        ),
        CheckConstraint("size IS NULL OR size >= 0", name="size"),
        CheckConstraint("ordinal >= 0", name="ordinal"),
        UniqueConstraint("job_id", "ordinal"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID, primary_key=True)
    job_id: Mapped[uuid.UUID] = mapped_column(UUID, ForeignKey("jobs.id", ondelete="CASCADE"))
    ordinal: Mapped[int] = mapped_column(SmallInteger)
    level: Mapped[str | None] = mapped_column(Text)
    state: Mapped[str] = mapped_column(Text, server_default=ResultState.PENDING.value)
    storage_key: Mapped[str | None] = mapped_column(Text)
    size: Mapped[int | None] = mapped_column(BigInteger)
    mime: Mapped[str] = mapped_column(Text)
    download_name: Mapped[str] = mapped_column(Text)
    details: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    error_code: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(TIMESTAMP, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(TIMESTAMP, server_default=func.now())


class OutboxEntry(Base):
    """Transaktionale Outbox: wird mit dem Auftrag committet, der Dispatcher
    (B04) veröffentlicht sie wiederholbar an den Broker bzw. den Cleanup."""

    __tablename__ = "outbox"
    __table_args__ = (
        CheckConstraint(in_values("kind", OutboxKind), name="kind"),
        CheckConstraint("attempts >= 0", name="attempts"),
        Index(
            "ix_outbox_pending",
            "available_at",
            postgresql_where=text("published_at IS NULL"),
        ),
        Index(None, "job_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    kind: Mapped[str] = mapped_column(Text)
    job_id: Mapped[uuid.UUID] = mapped_column(UUID, ForeignKey("jobs.id", ondelete="CASCADE"))
    available_at: Mapped[datetime] = mapped_column(TIMESTAMP, server_default=func.now())
    attempts: Mapped[int] = mapped_column(Integer, server_default="0")
    published_at: Mapped[datetime | None] = mapped_column(TIMESTAMP)
    # Nur interner Fehlercode/Ausnahmetyp, nie Ausnahmetext (Vertrag §2).
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(TIMESTAMP, server_default=func.now())


class UploadReservation(Base):
    """Platz für einen laufenden Upload (Vertrag §4 Schritt 3)."""

    __tablename__ = "upload_reservations"
    __table_args__ = (
        CheckConstraint("bytes > 0", name="bytes"),
        Index(None, "expires_at"),
        Index(None, "session_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID, primary_key=True)
    session_id: Mapped[uuid.UUID] = mapped_column(UUID, ForeignKey("sessions.id"))
    bytes: Mapped[int] = mapped_column(BigInteger)
    spool_key: Mapped[str] = mapped_column(Text, unique=True)
    created_at: Mapped[datetime] = mapped_column(TIMESTAMP, server_default=func.now())
    expires_at: Mapped[datetime] = mapped_column(TIMESTAMP)


class StorageUsage(Base):
    """Eine einzige Zeile: aktuell reservierte Bytes im Speicherbudget.

    Reservieren ist ein bedingtes Update (``reserved + n <= budget``); das
    Budget selbst ist Konfiguration und steht nicht in der Datenbank.
    """

    __tablename__ = "storage_usage"
    __table_args__ = (
        CheckConstraint("id = 1", name="single_row"),
        CheckConstraint("reserved_bytes >= 0", name="reserved_bytes"),
    )

    id: Mapped[int] = mapped_column(SmallInteger, primary_key=True)
    reserved_bytes: Mapped[int] = mapped_column(BigInteger, server_default="0")
