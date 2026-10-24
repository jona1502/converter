"""Keep abandoned conversion budget until parser hard-stop deadline."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "stale_attempts",
        sa.Column("lease_token", postgresql.UUID(), nullable=False),
        sa.Column("job_id", postgresql.UUID(), nullable=False),
        sa.Column("reserved_bytes", sa.BigInteger(), nullable=False),
        sa.Column("reap_after", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("reserved_bytes >= 0", name="ck_stale_attempts_reserved_bytes"),
        sa.ForeignKeyConstraint(["job_id"], ["jobs.id"], name="fk_stale_attempts_job_id_jobs"),
        sa.PrimaryKeyConstraint("lease_token", name="pk_stale_attempts"),
    )
    op.create_index("ix_stale_attempts_job_id", "stale_attempts", ["job_id"])
    op.create_index("ix_stale_attempts_reap_after", "stale_attempts", ["reap_after"])


def downgrade() -> None:
    op.drop_table("stale_attempts")
