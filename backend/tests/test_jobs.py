"""B03: dauerhafte Annahme, Besitzerbindung und sichere Teiluploads."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from sqlalchemy import text

from app.db.engine import Database
from tests.helpers import (
    CONTENT_TYPE,
    IMAGE_OPTIONS,
    PDF_BYTES,
    PNG_BYTES,
    ApiClient,
    job_body,
    multipart,
    new_key,
    raw_request,
)


def assert_no_upload_left(database: Database, storage_dir: Path) -> None:
    with database.engine.connect() as db:
        assert db.execute(text("SELECT count(*) FROM upload_reservations")).scalar_one() == 0
        assert db.execute(text("SELECT count(*) FROM jobs")).scalar_one() == 0
        assert db.execute(text("SELECT reserved_bytes FROM storage_usage")).scalar_one() == 0
    assert not list(storage_dir.rglob("input"))
    assert not [p for p in (storage_dir / "spool").glob("*") if p.is_file()]


def test_accepted_job_has_input_results_and_transactional_outbox(
    api: ApiClient, database: Database, storage_dir: Path
) -> None:
    api.start_session()
    job = api.create_job()
    assert job["state"] == "queued"
    assert job["input"]["format"] == "png"
    assert job["input"]["size"] == len(PNG_BYTES)
    assert len(job["results"]) == 1
    assert job["results"][0]["state"] == "pending"
    assert api.get_job(job["id"]).json() == job
    assert (storage_dir / "jobs" / job["id"] / "input").read_bytes() == PNG_BYTES
    with database.engine.connect() as db:
        assert (
            db.execute(text("SELECT count(*) FROM outbox WHERE kind = 'dispatch'")).scalar_one()
            == 1
        )
        assert db.execute(text("SELECT count(*) FROM upload_reservations")).scalar_one() == 0
        assert db.execute(text("SELECT reserved_bytes FROM storage_usage")).scalar_one() == len(
            PNG_BYTES
        )


def test_pdf_results_follow_requested_order(api: ApiClient) -> None:
    api.start_session()
    job = api.create_job({"tool": "pdf-compress", "levels": ["small", "high"]}, PDF_BYTES)
    assert [result["level"] for result in job["results"]] == ["small", "high"]


def test_idempotent_replay_does_not_duplicate_files_or_outbox(
    api: ApiClient, database: Database
) -> None:
    api.start_session()
    body, key = job_body(IMAGE_OPTIONS, PNG_BYTES), new_key()
    first = api.post_job(body, key=key)
    replay = api.post_job(body, key=key)
    assert first.status_code == 202
    assert replay.status_code == 200
    assert replay.headers["idempotent-replayed"] == "true"
    assert replay.json()["id"] == first.json()["id"]
    with database.engine.connect() as db:
        assert db.execute(text("SELECT count(*) FROM jobs")).scalar_one() == 1
        assert db.execute(text("SELECT count(*) FROM outbox")).scalar_one() == 1
    conflict = api.post_job(job_body(IMAGE_OPTIONS, PNG_BYTES + b"changed"), key=key)
    assert conflict.status_code == 409


def test_other_session_cannot_read_or_delete_job(api: ApiClient) -> None:
    api.start_session()
    job = api.create_job()
    api.client.cookies.clear()
    api.start_session()
    missing = api.get_job("00000000-0000-4000-8000-000000000000")
    foreign = api.get_job(job["id"])
    assert foreign.status_code == missing.status_code == 404
    assert foreign.json()["error"]["code"] == missing.json()["error"]["code"]
    assert api.delete_job(job["id"]).status_code == 404


def test_delete_immediately_hides_job_and_is_repeat_safe(api: ApiClient) -> None:
    api.start_session()
    job = api.create_job()
    assert api.delete_job(job["id"]).status_code == 204
    assert api.get_job(job["id"]).status_code == 404
    assert api.delete_job(job["id"]).status_code == 404


@pytest.mark.parametrize(
    "body",
    [
        job_body(IMAGE_OPTIONS, b"not an image"),
        job_body(b'{"tool":"image-convert","format":"webp","unknown":1}', PNG_BYTES),
        multipart(
            [("file", "photo.png", PNG_BYTES), ("options", None, b'{"tool":"pdf-compress"}')]
        ),
        job_body(IMAGE_OPTIONS, PNG_BYTES)[:-12],
    ],
)
def test_rejected_upload_releases_storage(
    api: ApiClient, database: Database, storage_dir: Path, body: bytes
) -> None:
    api.start_session()
    assert api.post_job(body).status_code in {400, 415, 422}
    assert_no_upload_left(database, storage_dir)


def test_disconnected_upload_removes_partial_file(
    api: ApiClient, db_app: FastAPI, database: Database, storage_dir: Path
) -> None:
    api.start_session()
    body = job_body(IMAGE_OPTIONS, PNG_BYTES * 100)
    headers = api.write_headers(
        **{"Content-Type": CONTENT_TYPE, "Cookie": f"converter_session={api.session_cookie()}"}
    )
    response = raw_request(
        db_app,
        method="POST",
        path="/api/v1/jobs",
        headers=headers,
        chunks=[body[:-100]],
        disconnect=True,
    )
    assert response.status in {0, 400}
    assert_no_upload_left(database, storage_dir)


def test_oversized_image_header_is_rejected_before_decode(
    api: ApiClient, database: Database, storage_dir: Path, db_app: FastAPI
) -> None:
    # Lower configured limits make this a real, small image rather than a bomb fixture.
    db_app.state.settings = db_app.state.settings.model_copy(update={"image_max_pixels": 1})
    from io import BytesIO

    from PIL import Image

    image = BytesIO()
    Image.new("RGB", (2, 2)).save(image, format="PNG")
    api.start_session()
    response = api.post_job(job_body(IMAGE_OPTIONS, image.getvalue()))
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "dimensions-too-large"
    assert_no_upload_left(database, storage_dir)


def test_animation_is_rejected(api: ApiClient, database: Database, storage_dir: Path) -> None:
    from io import BytesIO

    from PIL import Image

    image = BytesIO()
    Image.new("RGB", (2, 2), "red").save(
        image,
        format="GIF",
        save_all=True,
        append_images=[Image.new("RGB", (2, 2), "blue")],
        duration=100,
        loop=0,
    )
    api.start_session()
    response = api.post_job(job_body(IMAGE_OPTIONS, image.getvalue(), "animation.gif"))
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "animated-unsupported"
    assert_no_upload_left(database, storage_dir)


@pytest.mark.parametrize("declared_length", [None, "1"])
def test_stream_limit_without_truthful_content_length(
    api: ApiClient,
    db_app: FastAPI,
    database: Database,
    storage_dir: Path,
    declared_length: str | None,
) -> None:
    db_app.state.settings = db_app.state.settings.model_copy(
        update={"image_max_input_bytes": len(PNG_BYTES)}
    )
    api.start_session()
    headers = api.write_headers(
        **{"Content-Type": CONTENT_TYPE, "Cookie": f"converter_session={api.session_cookie()}"}
    )
    if declared_length is not None:
        headers["Content-Length"] = declared_length
    body = job_body(IMAGE_OPTIONS, PNG_BYTES + b"oversized")
    response = raw_request(
        db_app, method="POST", path="/api/v1/jobs", headers=headers, chunks=[body[:100], body[100:]]
    )
    assert response.status == 413
    assert_no_upload_left(database, storage_dir)


def test_promote_failure_after_rename_rolls_back_all_resources(
    api: ApiClient, database: Database, storage_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.storage.local import LocalStorage

    original = LocalStorage.promote

    def fail_after_rename(storage: LocalStorage, source: str, target: str) -> None:
        original(storage, source, target)
        raise OSError("simulated directory fsync failure")

    monkeypatch.setattr(LocalStorage, "promote", fail_after_rename)
    api.start_session()
    response = api.post_job(job_body(IMAGE_OPTIONS, PNG_BYTES))
    assert response.status_code in {500, 503}
    assert "fsync" not in response.text
    assert_no_upload_left(database, storage_dir)
    with database.engine.connect() as db:
        assert db.execute(text("SELECT count(*) FROM outbox")).scalar_one() == 0
