"""Transaktionale Outbox mit wiederholbarer Broker-Veröffentlichung."""

from __future__ import annotations

import time
from collections.abc import Callable
from datetime import timedelta

from sqlalchemy import func, select

from app.core.config import Settings
from app.db.engine import Database
from app.db.models import OutboxEntry
from app.jobs.runtime import recover


def dispatch_once(database: Database, send: Callable[[str], object]) -> int:
    sent = 0
    with database.session() as db, db.begin():
        entries = list(
            db.scalars(
                select(OutboxEntry)
                .where(
                    OutboxEntry.kind == "dispatch",
                    OutboxEntry.published_at.is_(None),
                    OutboxEntry.available_at <= func.now(),
                )
                .order_by(OutboxEntry.id)
                .limit(20)
                .with_for_update(skip_locked=True)
            )
        )
        for entry in entries:
            entry.attempts += 1
            try:
                send(str(entry.job_id))
                entry.published_at = func.now()
                entry.last_error = None
                sent += 1
            except Exception as exc:
                entry.last_error = type(exc).__name__[:80]
                entry.available_at = func.now() + timedelta(
                    seconds=min(60, 2 ** min(entry.attempts, 6))
                )
    return sent


def main() -> None:
    from app.worker.celery_app import celery_app

    settings = Settings()
    if settings.database_url is None:
        raise RuntimeError("database required")
    database = Database(settings.database_url.get_secret_value(), pool_size=2)
    while True:
        try:
            recover(database)
            dispatch_once(
                database,
                lambda job_id: celery_app.send_task(
                    "converter.process",
                    args=[job_id],
                    retry=False,
                ),
            )
        except Exception:
            time.sleep(2)
        time.sleep(1)


if __name__ == "__main__":
    main()
