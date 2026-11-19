"""image-pdf through the converter process protocol."""

from __future__ import annotations

from pathlib import Path

import pytest

from tests.helpers import encode, new_id, request, run_cli, target_file
from tests.test_image_pdf import BLUE, RED, boxes, bundle, encoded, solid


def test_cli_end_to_end(tmp_path: Path) -> None:
    source = bundle(tmp_path, [encoded(solid(RED), "PNG"), encoded(solid(BLUE), "JPEG")])
    target = target_file(tmp_path / "output.pdf")
    result_id = new_id()
    options = {"tool": "image-pdf", "pageSize": "letter", "orientation": "landscape"}
    result = run_cli(["run"], encode(request(source, options, [(result_id, None, target)])))
    assert result.returncode == 0, result.stderr
    assert result.events[-1] == {"kind": "result", "id": result_id, "details": {"pageCount": 2}}
    assert boxes(target) == [pytest.approx((792, 612), abs=0.01)] * 2


def test_cli_reports_error_and_clears_result(tmp_path: Path) -> None:
    source = tmp_path / "bundle.zip"
    source.write_bytes(b"plain text")
    target = target_file(tmp_path / "output.pdf")
    result_id = new_id()
    result = run_cli(
        ["run"], encode(request(source, {"tool": "image-pdf"}, [(result_id, None, target)]))
    )
    assert result.events[-1] == {"kind": "error", "id": result_id, "code": "decode-failed"}
    assert target.stat().st_size == 0
