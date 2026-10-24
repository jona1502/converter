"""Ausgangsschema: Sitzungen, Aufträge, Ergebnisse, Outbox, Reservierungen.

Revision ID: 0001
Revises: -
Create Date: 2026-10-24

Aus den Modellen in ``app/db/models.py`` erzeugt und geprüft; ein Test
vergleicht Modelle und migrierte Datenbank.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "sessions",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("token_hash", sa.LargeBinary(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "octet_length(token_hash) = 32", name=op.f("ck_sessions_token_hash_length")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_sessions")),
        sa.UniqueConstraint("token_hash", name=op.f("uq_sessions_token_hash")),
    )
    op.create_index(op.f("ix_sessions_expires_at"), "sessions", ["expires_at"], unique=False)
    op.create_table(
        "storage_usage",
        sa.Column("id", sa.SmallInteger(), nullable=False),
        sa.Column("reserved_bytes", sa.BigInteger(), server_default="0", nullable=False),
        sa.CheckConstraint("id = 1", name=op.f("ck_storage_usage_single_row")),
        sa.CheckConstraint("reserved_bytes >= 0", name=op.f("ck_storage_usage_reserved_bytes")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_storage_usage")),
    )
    # Genau eine Zeile; Reservieren/Freigeben sind bedingte Updates darauf.
    op.execute("INSERT INTO storage_usage (id, reserved_bytes) VALUES (1, 0)")
    op.create_table(
        "jobs",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("session_id", sa.UUID(), nullable=False),
        sa.Column("tool", sa.Text(), nullable=False),
        sa.Column("state", sa.Text(), server_default="queued", nullable=False),
        sa.Column("phase", sa.Text(), nullable=True),
        sa.Column("options", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("input_name", sa.Text(), nullable=False),
        sa.Column("input_size", sa.BigInteger(), nullable=False),
        sa.Column("input_format", sa.Text(), nullable=False),
        sa.Column("input_sha256", sa.LargeBinary(), nullable=False),
        sa.Column("input_storage_key", sa.Text(), nullable=False),
        sa.Column("input_width", sa.Integer(), nullable=True),
        sa.Column("input_height", sa.Integer(), nullable=True),
        sa.Column("idempotency_key", sa.Text(), nullable=True),
        sa.Column("fingerprint", sa.LargeBinary(), nullable=True),
        sa.Column("version", sa.Integer(), server_default="0", nullable=False),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column("max_attempts", sa.Integer(), nullable=False),
        sa.Column("lease_token", sa.UUID(), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cancel_requested_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "accepted_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("error_code", sa.Text(), nullable=True),
        sa.Column("progress", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("analysis", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("reserved_bytes", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("working_bytes", sa.BigInteger(), server_default="0", nullable=False),
        sa.CheckConstraint(
            "input_format IN ('jpeg', 'png', 'webp', 'gif', 'bmp', 'ico', 'avif', 'pdf')",
            name=op.f("ck_jobs_input_format"),
        ),
        sa.CheckConstraint(
            "phase IS NULL OR (phase IN ('analyze', 'variant', 'encode', 'save'))",
            name=op.f("ck_jobs_phase"),
        ),
        sa.CheckConstraint(
            "phase IS NULL OR state = 'running'", name=op.f("ck_jobs_phase_only_running")
        ),
        sa.CheckConstraint(
            "state <> 'failed' OR error_code IS NOT NULL", name=op.f("ck_jobs_failed_error")
        ),
        sa.CheckConstraint(
            "state <> 'running' OR lease_token IS NOT NULL", name=op.f("ck_jobs_running_lease")
        ),
        sa.CheckConstraint(
            "state IN ('queued', 'running', 'succeeded', 'partially_succeeded', 'failed', 'cancelled', 'expired')",
            name=op.f("ck_jobs_state"),
        ),
        sa.CheckConstraint(
            "tool IN ('image-convert', 'image-compress', 'image-resize', 'pdf-compress')",
            name=op.f("ck_jobs_tool"),
        ),
        sa.CheckConstraint(
            "(idempotency_key IS NULL) = (fingerprint IS NULL)",
            name=op.f("ck_jobs_idempotency_pair"),
        ),
        sa.CheckConstraint(
            "attempts >= 0 AND max_attempts >= 1 AND attempts <= max_attempts",
            name=op.f("ck_jobs_attempts"),
        ),
        sa.CheckConstraint("input_size >= 0", name=op.f("ck_jobs_input_size")),
        sa.CheckConstraint(
            "octet_length(input_sha256) = 32", name=op.f("ck_jobs_input_sha256_length")
        ),
        sa.CheckConstraint(
            "reserved_bytes >= 0 AND working_bytes >= 0", name=op.f("ck_jobs_bytes")
        ),
        sa.CheckConstraint("version >= 0", name=op.f("ck_jobs_version")),
        sa.ForeignKeyConstraint(
            ["session_id"], ["sessions.id"], name=op.f("fk_jobs_session_id_sessions")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_jobs")),
        sa.UniqueConstraint(
            "session_id", "idempotency_key", name=op.f("uq_jobs_session_id_idempotency_key")
        ),
    )
    op.create_index(
        "ix_jobs_active_session",
        "jobs",
        ["session_id"],
        unique=False,
        postgresql_where=sa.text("state IN ('queued', 'running') AND deleted_at IS NULL"),
    )
    op.create_index(
        "ix_jobs_deleted_at",
        "jobs",
        ["deleted_at"],
        unique=False,
        postgresql_where=sa.text("deleted_at IS NOT NULL"),
    )
    op.create_index(op.f("ix_jobs_expires_at"), "jobs", ["expires_at"], unique=False)
    op.create_index(
        "ix_jobs_lease_expires_at_running",
        "jobs",
        ["lease_expires_at"],
        unique=False,
        postgresql_where=sa.text("state = 'running'"),
    )
    op.create_table(
        "upload_reservations",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("session_id", sa.UUID(), nullable=False),
        sa.Column("bytes", sa.BigInteger(), nullable=False),
        sa.Column("spool_key", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("bytes > 0", name=op.f("ck_upload_reservations_bytes")),
        sa.ForeignKeyConstraint(
            ["session_id"], ["sessions.id"], name=op.f("fk_upload_reservations_session_id_sessions")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_upload_reservations")),
        sa.UniqueConstraint("spool_key", name=op.f("uq_upload_reservations_spool_key")),
    )
    op.create_index(
        op.f("ix_upload_reservations_expires_at"),
        "upload_reservations",
        ["expires_at"],
        unique=False,
    )
    op.create_index(
        op.f("ix_upload_reservations_session_id"),
        "upload_reservations",
        ["session_id"],
        unique=False,
    )
    op.create_table(
        "job_results",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("job_id", sa.UUID(), nullable=False),
        sa.Column("ordinal", sa.SmallInteger(), nullable=False),
        sa.Column("level", sa.Text(), nullable=True),
        sa.Column("state", sa.Text(), server_default="pending", nullable=False),
        sa.Column("storage_key", sa.Text(), nullable=True),
        sa.Column("size", sa.BigInteger(), nullable=True),
        sa.Column("mime", sa.Text(), nullable=False),
        sa.Column("download_name", sa.Text(), nullable=False),
        sa.Column("details", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("error_code", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "level IS NULL OR (level IN ('high', 'balanced', 'small'))",
            name=op.f("ck_job_results_level"),
        ),
        sa.CheckConstraint(
            "state <> 'succeeded' OR (storage_key IS NOT NULL AND size IS NOT NULL)",
            name=op.f("ck_job_results_succeeded_has_file"),
        ),
        sa.CheckConstraint(
            "state IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')",
            name=op.f("ck_job_results_state"),
        ),
        sa.CheckConstraint("ordinal >= 0", name=op.f("ck_job_results_ordinal")),
        sa.CheckConstraint("size IS NULL OR size >= 0", name=op.f("ck_job_results_size")),
        sa.ForeignKeyConstraint(
            ["job_id"], ["jobs.id"], name=op.f("fk_job_results_job_id_jobs"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_job_results")),
        sa.UniqueConstraint("job_id", "ordinal", name=op.f("uq_job_results_job_id_ordinal")),
    )
    op.create_table(
        "outbox",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=True), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("job_id", sa.UUID(), nullable=False),
        sa.Column(
            "available_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("kind IN ('dispatch', 'delete')", name=op.f("ck_outbox_kind")),
        sa.CheckConstraint("attempts >= 0", name=op.f("ck_outbox_attempts")),
        sa.ForeignKeyConstraint(
            ["job_id"], ["jobs.id"], name=op.f("fk_outbox_job_id_jobs"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_outbox")),
    )
    op.create_index(op.f("ix_outbox_job_id"), "outbox", ["job_id"], unique=False)
    op.create_index(
        "ix_outbox_pending",
        "outbox",
        ["available_at"],
        unique=False,
        postgresql_where=sa.text("published_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index(
        "ix_outbox_pending", table_name="outbox", postgresql_where=sa.text("published_at IS NULL")
    )
    op.drop_index(op.f("ix_outbox_job_id"), table_name="outbox")
    op.drop_table("outbox")
    op.drop_table("job_results")
    op.drop_index(op.f("ix_upload_reservations_session_id"), table_name="upload_reservations")
    op.drop_index(op.f("ix_upload_reservations_expires_at"), table_name="upload_reservations")
    op.drop_table("upload_reservations")
    op.drop_index(
        "ix_jobs_lease_expires_at_running",
        table_name="jobs",
        postgresql_where=sa.text("state = 'running'"),
    )
    op.drop_index(op.f("ix_jobs_expires_at"), table_name="jobs")
    op.drop_index(
        "ix_jobs_deleted_at", table_name="jobs", postgresql_where=sa.text("deleted_at IS NOT NULL")
    )
    op.drop_index(
        "ix_jobs_active_session",
        table_name="jobs",
        postgresql_where=sa.text("state IN ('queued', 'running') AND deleted_at IS NULL"),
    )
    op.drop_table("jobs")
    op.drop_table("storage_usage")
    op.drop_index(op.f("ix_sessions_expires_at"), table_name="sessions")
    op.drop_table("sessions")
