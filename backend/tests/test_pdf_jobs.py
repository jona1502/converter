"""PDF variants from real upload through child process to protected download."""

import io
from pathlib import Path

import pikepdf

from app.core.config import Settings
from app.worker.runner import run_job
from tests.helpers import ApiClient
from tests.test_pdf_processing import fixture_pdf


def test_pdf_job_publishes_three_downloadable_variants(
    api: ApiClient,
    db_settings: Settings,
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.pdf"
    fixture_pdf(source)
    api.start_session()
    job = api.create_job({"tool": "pdf-compress"}, source.read_bytes())
    run_job(job["id"], db_settings)
    view = api.get_job(job["id"]).json()
    assert view["state"] == "succeeded", view
    assert view["analysis"]["pageCount"] == 1
    assert [r["level"] for r in view["results"]] == ["high", "balanced", "small"]
    for result in view["results"]:
        download = api.client.get(result["downloadUrl"])
        assert download.status_code == 200
        assert download.headers["content-type"] == "application/pdf"
        assert len(download.content) == result["size"]
        with pikepdf.Pdf.open(io.BytesIO(download.content), attempt_recovery=False) as pdf:
            assert len(pdf.pages) == 1
            assert pdf.Root.AcroForm.Fields[0].V == "Alice"
            assert len(pdf.pages[0].Annots) == 1
