"""Worker transitions against PostgreSQL, including stale deliveries."""

import subprocess
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from typing import Any

import pytest
from sqlalchemy import func, select, update

from app.core.config import Settings
from app.db.engine import Database
from app.db.models import Job, JobResult, OutboxEntry, StorageUsage
from app.jobs import runtime
from app.jobs.dispatcher import dispatch_once
from app.worker.runner import run_job
from tests.helpers import PDF_BYTES, ApiClient


def create(api: ApiClient) -> uuid.UUID:
    api.start_session()
    return uuid.UUID(api.create_job()["id"])


def expire_lease(database: Database, job_id: uuid.UUID) -> None:
    with database.session() as db, db.begin():
        db.execute(
            update(Job)
            .where(Job.id == job_id)
            .values(lease_expires_at=func.now() - timedelta(seconds=1))
        )


def publish(database: Database, task: runtime.Claim, index: int = 0) -> bool:
    return runtime.event(
        database,
        task,
        {
            "kind": "result",
            "id": str(task.results[index][0]),
            "size": 10,
            "key": f"jobs/{task.id}/results/{task.results[index][0]}/{task.token}",
            "details": {"sourceWidth": 2, "sourceHeight": 2},
        },
    )


def test_concurrent_claim_has_exactly_one_owner(
    api: ApiClient, database: Database, settings: Settings
) -> None:
    job_id = create(api)
    with ThreadPoolExecutor(max_workers=2) as pool:
        claims = list(pool.map(lambda _: runtime.claim(database, job_id, settings), range(2)))
    assert sum(task is not None for task in claims) == 1
    with database.session() as db:
        job = db.get(Job, job_id)
        assert job and job.attempts == 1 and job.state == "running"


def test_expired_lease_cannot_publish_heartbeat_or_finish(
    api: ApiClient, database: Database, settings: Settings
) -> None:
    job_id = create(api)
    task = runtime.claim(database, job_id, settings)
    assert task
    expire_lease(database, job_id)
    assert not runtime.heartbeat(database, task)
    assert not publish(database, task)
    runtime.finish(database, task)
    with database.session() as db:
        job = db.get(Job, job_id)
        assert job and job.state == "running"
    assert runtime.recover(database) == 1
    replacement = runtime.claim(database, job_id, settings)
    assert replacement and replacement.token != task.token
    assert not publish(database, task)
    runtime.finish(database, task)
    assert publish(database, replacement)
    runtime.finish(database, replacement)
    with database.session() as db:
        job = db.get(Job, job_id)
        assert job and job.state == "succeeded" and job.working_bytes == 0
        usage = db.get(StorageUsage, 1)
        assert usage and usage.reserved_bytes == job.reserved_bytes


def test_cancellation_wins_over_late_publication(
    api: ApiClient, database: Database, settings: Settings
) -> None:
    job_id = create(api)
    task = runtime.claim(database, job_id, settings)
    assert task
    with database.session() as db, db.begin():
        job = db.get(Job, job_id, with_for_update=True)
        assert job
        assert runtime.cancel(db, job) == "requested"
    assert not publish(database, task)
    runtime.finish(database, task)
    with database.session() as db:
        job = db.get(Job, job_id)
        assert job and job.state == "cancelled" and job.working_bytes == 0
        assert not runtime.claim(database, job_id, settings)


def test_queued_cancel_is_idempotent(
    api: ApiClient, database: Database, settings: Settings
) -> None:
    job_id = create(api)
    with database.session() as db, db.begin():
        job = db.get(Job, job_id, with_for_update=True)
        assert job
        assert runtime.cancel(db, job) == "completed"
        assert runtime.cancel(db, job) == "completed"
    assert runtime.claim(database, job_id, settings) is None


def test_deleted_job_rejects_all_worker_updates(
    api: ApiClient, database: Database, settings: Settings
) -> None:
    job_id = create(api)
    task = runtime.claim(database, job_id, settings)
    assert task
    assert api.delete_job(str(job_id)).status_code == 204
    assert not runtime.heartbeat(database, task)
    assert not publish(database, task)
    runtime.finish(database, task)
    with database.session() as db:
        job = db.get(Job, job_id)
        assert job and job.state == "running" and job.deleted_at
    expire_lease(database, job_id)
    assert runtime.recover(database) == 1
    assert runtime.claim(database, job_id, settings) is None


def test_recovery_preserves_completed_pdf_results(
    api: ApiClient, database: Database, settings: Settings
) -> None:
    api.start_session()
    job_id = uuid.UUID(api.create_job({"tool": "pdf-compress"}, PDF_BYTES)["id"])
    with database.session() as db, db.begin():
        db.execute(update(Job).where(Job.id == job_id).values(max_attempts=1))
    task = runtime.claim(database, job_id, settings)
    assert task and publish(database, task)
    expire_lease(database, job_id)
    runtime.recover(database)
    with database.session() as db:
        job = db.get(Job, job_id)
        assert job and job.state == "partially_succeeded" and job.working_bytes == 0
        states = list(db.scalars(select(JobResult.state).where(JobResult.job_id == job_id)))
        assert sorted(states) == ["failed", "failed", "succeeded"]


def test_outbox_retries_broker_error_without_losing_job(api: ApiClient, database: Database) -> None:
    job_id = create(api)

    def broken_send(_: str) -> object:
        raise OSError("private connection string")

    assert dispatch_once(database, broken_send) == 0
    with database.session() as db, db.begin():
        entry = db.scalar(select(OutboxEntry).where(OutboxEntry.job_id == job_id))
        assert entry and entry.published_at is None and entry.last_error == "OSError"
        entry.available_at = func.now() - timedelta(seconds=1)
    sent: list[str] = []
    assert dispatch_once(database, sent.append) == 1
    assert dispatch_once(database, sent.append) == 0
    assert sent == [str(job_id)]


def test_hung_child_is_terminated_and_marks_timeout(
    api: ApiClient,
    database: Database,
    db_settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    job_id = create(api)
    real_popen = subprocess.Popen
    children: list[subprocess.Popen[str]] = []

    def slow_popen(command: list[str], **kwargs: Any) -> subprocess.Popen[str]:
        child = real_popen(
            [
                sys.executable,
                "-c",
                "import sys,time;sys.stdin.read();time.sleep(20)",
            ],
            **kwargs,
        )
        children.append(child)
        return child

    monkeypatch.setattr("app.worker.runner.subprocess.Popen", slow_popen)
    run_job(str(job_id), db_settings.model_copy(update={"image_timeout_seconds": 0.1}))
    assert children and children[0].poll() is not None
    with database.session() as db:
        job = db.get(Job, job_id)
        assert job and job.state == "failed" and job.error_code == "timeout"
        assert job.working_bytes == 0
        result = db.scalar(select(JobResult).where(JobResult.job_id == job_id))
        assert result and result.state == "failed" and result.storage_key is None
