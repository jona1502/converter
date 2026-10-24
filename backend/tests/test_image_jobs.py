"""Real image job and authorized download integration."""

import io
import uuid
from datetime import timedelta

from PIL import Image
from sqlalchemy import func, select, update

from app.core.config import Settings
from app.db.engine import Database
from app.db.models import Job, JobResult
from app.worker.runner import run_job
from tests.helpers import ApiClient


def test_real_child_image_job_completes(
    api: ApiClient,
    database: Database,
    db_settings: Settings,
) -> None:
    api.start_session()
    job_id = uuid.UUID(api.create_job()["id"])
    run_job(str(job_id), db_settings)
    response = api.get_job(str(job_id))
    assert response.status_code == 200
    view = response.json()
    assert view["state"] == "succeeded"
    assert view["results"][0]["size"] > 0
    download = api.client.get(view["results"][0]["downloadUrl"])
    assert download.status_code == 200
    assert download.headers["content-length"] == str(len(download.content))
    assert download.headers["content-type"] == "image/webp"
    assert download.headers["content-security-policy"] == "sandbox"
    assert download.headers["cache-control"] == "private, no-store"
    assert "attachment;" in download.headers["content-disposition"]
    with Image.open(io.BytesIO(download.content)) as image:
        image.load()
        assert image.format == "WEBP"
    with database.session() as db:
        result = db.scalar(select(JobResult).where(JobResult.job_id == job_id))
        assert result and result.storage_key
        from app.storage.local import LocalStorage

        assert LocalStorage(db_settings.storage_dir).exists(result.storage_key)
        job = db.get(Job, job_id)
        assert job and job.download_until


def test_download_authorization_expiry_and_cancel(
    api: ApiClient, database: Database, db_settings: Settings
) -> None:
    api.start_session()
    job = api.create_job()
    run_job(job["id"], db_settings)
    view = api.get_job(job["id"]).json()
    url = view["results"][0]["downloadUrl"]
    owner_cookies = dict(api.client.cookies)
    api.client.cookies.clear()
    api.start_session()
    assert api.client.get(url).status_code == 404
    assert (
        api.client.post(f"/api/v1/jobs/{job['id']}/cancel", headers=api.write_headers()).status_code
        == 404
    )
    api.client.cookies.clear()
    api.client.cookies.update(owner_cookies)
    with database.session() as db, db.begin():
        db.execute(
            update(Job)
            .where(Job.id == uuid.UUID(job["id"]))
            .values(expires_at=func.now() - timedelta(seconds=1))
        )
    assert api.client.get(url).status_code == 410


def test_capabilities_are_available_without_session(api: ApiClient) -> None:
    response = api.client.get("/api/v1/capabilities")
    assert response.status_code == 200
    assert set(response.json()["image"]["outputFormats"]) == {"jpeg", "png", "webp", "bmp", "ico"}
