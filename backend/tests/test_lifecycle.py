"""B09: quotas, leases, restart cleanup and shared rate controls."""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from pydantic import SecretStr
from sqlalchemy import text
from starlette.requests import Request

from app.api.errors import ApiError
from app.core.config import Settings
from app.core.rate_limits import check_limits, client_ip, replay_guard
from app.db.engine import Database
from app.jobs.cleanup import cleanup_once
from app.storage.local import LocalStorage
from tests.helpers import ApiClient


def test_session_and_global_admission(api: ApiClient, db_app: FastAPI) -> None:
    api.start_session()
    db_app.state.settings = db_app.state.settings.model_copy(update={"session_max_active_jobs": 1})
    api.create_job()
    from tests.helpers import IMAGE_OPTIONS, PNG_BYTES, job_body

    response = api.post_job(job_body(IMAGE_OPTIONS, PNG_BYTES))
    assert response.status_code == 429
    assert response.json()["error"]["code"] == "session-job-limit"
    api.client.cookies.clear()
    api.start_session()
    db_app.state.settings = db_app.state.settings.model_copy(update={"global_max_active_jobs": 1})
    response = api.post_job(job_body(IMAGE_OPTIONS, PNG_BYTES))
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "server-busy"


def test_cleanup_expiry_respects_download_lease_and_is_idempotent(
    api: ApiClient, database: Database, storage_dir: Path, db_app: FastAPI
) -> None:
    api.start_session()
    job = api.create_job()
    with database.engine.begin() as db:
        db.execute(
            text(
                "UPDATE jobs SET expires_at=now()-interval '1 second', "
                "download_until=now()+interval '10 seconds'"
            )
        )
    storage = LocalStorage(storage_dir)
    assert cleanup_once(database, storage, db_app.state.settings)["jobs"] == 0
    assert api.get_job(job["id"]).json()["state"] == "expired"
    assert (storage_dir / "jobs" / job["id"] / "input").exists()
    with database.engine.begin() as db:
        db.execute(text("UPDATE jobs SET download_until=now()-interval '1 second'"))
    assert cleanup_once(database, storage, db_app.state.settings)["jobs"] == 1
    assert cleanup_once(database, storage, db_app.state.settings)["jobs"] == 0
    assert api.get_job(job["id"]).status_code == 404
    with database.engine.connect() as db:
        assert db.execute(text("SELECT reserved_bytes FROM storage_usage")).scalar_one() == 0
    assert not (storage_dir / "jobs" / job["id"]).exists()


def test_trusted_proxy_chain(settings: Settings) -> None:
    import ipaddress

    configured = settings.model_copy(
        update={"trusted_proxies": [ipaddress.ip_network("10.0.0.0/8")]}
    )

    def request(peer: str, forwarded: str) -> Request:
        return Request(
            {
                "type": "http",
                "client": (peer, 123),
                "headers": [(b"x-forwarded-for", forwarded.encode())],
            }
        )

    assert client_ip(request("192.0.2.1", "1.1.1.1"), configured) == "192.0.2.1"
    assert client_ip(request("10.0.0.1", "1.1.1.1, 192.0.2.1"), configured) == "192.0.2.1"
    assert client_ip(request("10.0.0.1", "192.0.2.1, 10.0.0.2"), configured) == "192.0.2.1"


def test_shared_redis_windows_and_replay_lock(settings: Settings) -> None:
    # Dedicated Valkey logical DB and random identities avoid affecting runtime data.
    configured = settings.model_copy(update={"redis_url": SecretStr("redis://127.0.0.1:56379/15")})
    identity = uuid.uuid4().hex
    check_limits(configured, [("test", identity, 1)])
    with pytest.raises(ApiError) as exc:
        check_limits(configured, [("test", identity, 1)])
    assert exc.value.status == 429
    session_id = uuid.uuid4()
    with replay_guard(configured, session_id):
        with pytest.raises(ApiError) as exc, replay_guard(configured, session_id):
            pytest.fail("concurrent replay admitted")
        assert exc.value.status == 429
    with replay_guard(configured, session_id):
        pass


def test_redis_failure_fails_closed(settings: Settings) -> None:
    configured = settings.model_copy(update={"redis_url": SecretStr("redis://127.0.0.1:1/15")})
    with pytest.raises(ApiError) as exc:
        check_limits(configured, [("test", "unavailable", 1)])
    assert exc.value.status == 503


def test_cleanup_abandoned_upload_and_orphan_after_restart(
    api: ApiClient, database: Database, storage_dir: Path, db_app: FastAPI
) -> None:
    import os
    import time

    from sqlalchemy import select

    from app.db.models import AnonymousSession
    from app.jobs.admission import reserve_upload
    from app.storage.local import spool_key

    api.start_session()
    with database.session() as db:
        session_id = db.execute(select(AnonymousSession.id)).scalar_one()
    reservation = reserve_upload(database, db_app.state.settings, session_id)
    storage = LocalStorage(storage_dir)
    writer = storage.create(reservation.spool_key)
    writer.write(b"interrupted")
    writer.close()
    orphan = spool_key(uuid.uuid4())
    orphan_writer = storage.create(orphan)
    orphan_writer.write(b"orphan")
    orphan_writer.close()
    old = time.time() - 800
    os.utime(storage.path_for(orphan), (old, old))
    with database.engine.begin() as db:
        db.execute(text("UPDATE upload_reservations SET expires_at=now()-interval '20 seconds'"))
    counts = cleanup_once(database, LocalStorage(storage_dir), db_app.state.settings)
    assert counts["uploads"] == counts["orphans"] == 1
    assert not storage.exists(orphan)
    assert not storage.exists(reservation.spool_key)
    with database.engine.connect() as db:
        assert db.execute(text("SELECT reserved_bytes FROM storage_usage")).scalar_one() == 0


def test_idempotency_claim_prevents_duplicate_creation_tokens(settings: Settings) -> None:
    from app.core.rate_limits import submission_guard

    configured = settings.model_copy(update={"redis_url": SecretStr("redis://127.0.0.1:56379/15")})
    identity = uuid.uuid4().hex
    with submission_guard(configured, "idempotency-lock", identity):
        with (
            pytest.raises(ApiError) as exc,
            submission_guard(configured, "idempotency-lock", identity),
        ):
            pytest.fail("same payload admitted concurrently")
        assert exc.value.status == 429
    with submission_guard(configured, "idempotency-lock", identity):
        pass


def test_cleanup_stale_lease_results_within_live_job(
    api: ApiClient, database: Database, storage_dir: Path, db_app: FastAPI
) -> None:
    import os
    import time

    from app.storage.local import result_key

    api.start_session()
    job = api.create_job()
    storage = LocalStorage(storage_dir)
    key = result_key(uuid.UUID(job["id"]), uuid.uuid4(), uuid.uuid4())
    writer = storage.create(key)
    writer.write(b"crashed-worker-output")
    writer.close()
    old = time.time() - 20
    os.utime(storage.path_for(key), (old, old))
    with database.engine.begin() as db:
        db.execute(text("UPDATE jobs SET updated_at=now()-interval '20 seconds'"))
    assert cleanup_once(database, storage, db_app.state.settings)["orphans"] == 1
    assert not storage.exists(key)
    assert api.get_job(job["id"]).status_code == 200


def test_admission_snapshot_during_reservation_to_job_transition(
    api: ApiClient, database: Database, db_app: FastAPI
) -> None:
    from sqlalchemy import event, select

    from app.db.models import AnonymousSession
    from app.jobs.admission import reserve_upload
    from tests.helpers import IMAGE_OPTIONS, PNG_BYTES, job_body

    api.start_session()
    api.create_job()
    with database.engine.begin() as db:
        db.execute(text("UPDATE jobs SET state='failed', error_code='worker-failed'"))
    with database.session() as session:
        owner = session.execute(select(AnonymousSession.id)).scalar_one()
    reservation = reserve_upload(database, db_app.state.settings, owner)
    db_app.state.settings = db_app.state.settings.model_copy(update={"session_max_active_jobs": 1})
    transitioned = False

    def transition(*args: Any) -> None:
        nonlocal transitioned
        statement = args[2]
        if not transitioned and "SELECT jobs.session_id" in statement:
            transitioned = True
            # Simulate acceptance commit just after the quota read snapshot.
            with database.engine.begin() as db:
                db.execute(text("UPDATE jobs SET state='queued', error_code=NULL"))
                db.execute(text("DELETE FROM upload_reservations"))
                db.execute(
                    text("UPDATE storage_usage SET reserved_bytes=reserved_bytes-:amount"),
                    {"amount": reservation.bytes},
                )

    event.listen(database.engine, "after_cursor_execute", transition)
    try:
        response = api.post_job(job_body(IMAGE_OPTIONS, PNG_BYTES))
    finally:
        event.remove(database.engine, "after_cursor_execute", transition)
    assert transitioned
    assert response.status_code == 429


@pytest.mark.parametrize("retirement", ["recovery", "expiry", "delete"])
def test_stale_attempt_retains_budget_and_published_results_until_reaped(
    api: ApiClient, database: Database, storage_dir: Path, db_app: FastAPI, retirement: str
) -> None:
    from sqlalchemy import select

    from app.db.models import Job, StaleAttempt, StorageUsage
    from app.jobs import runtime
    from app.storage.local import result_key
    from tests.helpers import PDF_BYTES

    api.start_session()
    job_id = uuid.UUID(api.create_job({"tool": "pdf-compress"}, PDF_BYTES)["id"])
    settings = db_app.state.settings
    task = runtime.claim(database, job_id, settings)
    assert task
    storage = LocalStorage(storage_dir)
    published = result_key(job_id, task.results[0][0], task.token)
    partial = result_key(job_id, task.results[1][0], task.token)
    for key in (published, partial):
        writer = storage.create(key)
        writer.write(b"1234567890")
        writer.close()
    assert runtime.event(
        database,
        task,
        {
            "kind": "result",
            "id": str(task.results[0][0]),
            "key": published,
            "size": 10,
            "details": {},
        },
    )
    with database.session() as session:
        before = session.get(StorageUsage, 1)
        assert before
        budget_before = before.reserved_bytes
    if retirement == "recovery":
        with database.engine.begin() as connection:
            connection.execute(text("UPDATE jobs SET lease_expires_at=now()-interval '1 second'"))
        assert runtime.recover(database, settings) == 1
    elif retirement == "expiry":
        with database.engine.begin() as connection:
            connection.execute(text("UPDATE jobs SET expires_at=now()-interval '1 second'"))
        cleanup_once(database, storage, settings)
    else:
        assert api.delete_job(str(job_id)).status_code == 204
        cleanup_once(database, storage, settings)
    with database.session() as session:
        stale = session.scalar(select(StaleAttempt))
        job = session.get(Job, job_id)
        usage = session.get(StorageUsage, 1)
        assert stale and stale.reserved_bytes == settings.pdf_max_results_total_bytes - 10
        assert job and job.working_bytes == 0
        assert usage and usage.reserved_bytes == budget_before
    # Before the child hard-stop deadline, restart cleanup cannot reclaim it.
    cleanup_once(database, LocalStorage(storage_dir), settings)
    assert storage.exists(published) and storage.exists(partial)
    if retirement == "recovery":
        replacement = runtime.claim(database, job_id, settings)
        assert replacement
        with database.session() as session:
            usage = session.get(StorageUsage, 1)
            assert usage and usage.reserved_bytes > budget_before
    with database.engine.begin() as connection:
        connection.execute(text("UPDATE stale_attempts SET reap_after=now()-interval '1 second'"))
    counts = cleanup_once(database, LocalStorage(storage_dir), settings)
    assert counts["staleAttempts"] == 1
    assert not storage.exists(partial)
    if retirement == "recovery":
        assert storage.exists(published)
        with database.session() as session:
            assert session.scalar(select(StaleAttempt)) is None
            job = session.get(Job, job_id)
            usage = session.get(StorageUsage, 1)
            assert job and usage and usage.reserved_bytes == job.reserved_bytes + job.working_bytes
    else:
        with database.session() as session:
            assert session.get(Job, job_id) is None
            usage = session.get(StorageUsage, 1)
            assert usage and usage.reserved_bytes == 0
