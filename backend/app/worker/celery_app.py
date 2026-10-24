"""Celery transportiert IDs; Status und Wiederanlauf bleiben in PostgreSQL."""

from __future__ import annotations

from celery import Celery  # type: ignore[import-untyped]

from app.core.config import Settings

settings = Settings()
celery_app = Celery(
    "converter",
    broker=(
        settings.redis_url.get_secret_value() if settings.redis_url else "redis://127.0.0.1:56379/0"
    ),
)
celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    task_ignore_result=True,
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    worker_prefetch_multiplier=1,
    worker_concurrency=1,
    broker_connection_retry_on_startup=True,
    broker_transport_options={"visibility_timeout": 600},
)


def process(job_id: str) -> None:
    from app.worker.runner import run_job

    run_job(job_id)


celery_app.task(name="converter.process")(process)
