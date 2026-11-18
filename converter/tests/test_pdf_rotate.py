"""PDF drehen: nur /Rotate ändert sich, Inhalt bleibt byte-identisch."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pikepdf
import pypdfium2 as pdfium  # type: ignore[import-untyped]
import pytest
from pikepdf import Pdf

from converter.errors import ProcessingError
from converter.limits import Limits
from converter.processing.pdf.rotate import rotate, selected_pages
from converter.rotate_options import PdfRotateOptions
from tests.helpers import encode, new_id, request, run_cli, target_file


def make_pdf(path: Path, pages: int = 4, rotations: dict[int, int] | None = None) -> None:
    with Pdf.new() as pdf:
        for index in range(pages):
            page = pdf.add_blank_page(page_size=(200, 100))
            page.Contents = pdf.make_stream(f"BT 0 0 Td ET % page {index}".encode())
            if rotations and index in rotations:
                page.Rotate = rotations[index]
        pdf.save(path)


def run(
    tmp_path: Path, options: PdfRotateOptions, limits: Limits | None = None
) -> tuple[Path, dict[str, object]]:
    source, target = tmp_path / "in.pdf", tmp_path / "out.pdf"
    if not target.exists():
        target_file(target)
    details = rotate(source, target, options, limits or Limits())
    return target, details


def rotations(path: Path) -> list[int]:
    with Pdf.open(path) as pdf:
        return [int(page.obj.get("/Rotate", 0)) for page in pdf.pages]


def test_selected_pages() -> None:
    assert selected_pages("all", 3) == [0, 1, 2]
    assert selected_pages("3,1-2,2", 5) == [0, 1, 2]
    with pytest.raises(ProcessingError) as exc:
        selected_pages("2-6", 5)
    assert exc.value.code == "invalid-options"


def test_rotates_all_pages(tmp_path: Path) -> None:
    make_pdf(tmp_path / "in.pdf")
    out, details = run(tmp_path, PdfRotateOptions(angle=90))
    assert details == {"pageCount": 4, "rotatedPages": 4}
    assert rotations(out) == [90, 90, 90, 90]
    with pdfium.PdfDocument(out) as doc:
        assert [page.get_size() for page in doc] == [(100.0, 200.0)] * 4


def test_rotates_only_selected_pages_and_keeps_content(tmp_path: Path) -> None:
    make_pdf(tmp_path / "in.pdf")
    out, details = run(tmp_path, PdfRotateOptions(angle=180, pages="2-3"))
    assert details == {"pageCount": 4, "rotatedPages": 2}
    assert rotations(out) == [0, 180, 180, 0]
    with Pdf.open(tmp_path / "in.pdf") as before, Pdf.open(out) as after:
        for old, new in zip(before.pages, after.pages, strict=True):
            assert old.Contents.read_bytes() == new.Contents.read_bytes()
            assert list(old.MediaBox) == list(new.MediaBox)


def test_rotation_is_relative_and_wraps(tmp_path: Path) -> None:
    make_pdf(tmp_path / "in.pdf", pages=3, rotations={0: 90, 1: 270, 2: 180})
    out, _ = run(tmp_path, PdfRotateOptions(angle=270))
    assert rotations(out) == [0, 180, 90]


def test_inherited_rotate_is_respected(tmp_path: Path) -> None:
    source = tmp_path / "in.pdf"
    make_pdf(source, pages=1)
    with Pdf.open(source, allow_overwriting_input=True) as pdf:
        pdf.Root.Pages.Rotate = 90
        pdf.save(source)
    out, _ = run(tmp_path, PdfRotateOptions(angle=90))
    with pdfium.PdfDocument(out) as doc:
        assert doc[0].get_rotation() == 180


def test_page_beyond_end_is_invalid_options(tmp_path: Path) -> None:
    make_pdf(tmp_path / "in.pdf", pages=2)
    with pytest.raises(ProcessingError) as exc:
        run(tmp_path, PdfRotateOptions(angle=90, pages="2-3"))
    assert exc.value.code == "invalid-options"


def test_encrypted_pdf_is_rejected(tmp_path: Path) -> None:
    source = tmp_path / "in.pdf"
    with Pdf.new() as pdf:
        pdf.add_blank_page()
        pdf.save(source, encryption=pikepdf.Encryption(owner="owner", user=""))
    with pytest.raises(ProcessingError) as exc:
        run(tmp_path, PdfRotateOptions(angle=90))
    assert exc.value.code == "encrypted"


def test_not_pdf_damaged_and_limits(tmp_path: Path) -> None:
    source = tmp_path / "in.pdf"
    source.write_bytes(b"hello")
    with pytest.raises(ProcessingError) as exc:
        run(tmp_path, PdfRotateOptions(angle=90))
    assert exc.value.code == "not-pdf"
    make_pdf(source)
    with pytest.raises(ProcessingError) as exc:
        run(tmp_path, PdfRotateOptions(angle=90), replace(Limits(), pdf_max_input_bytes=10))
    assert exc.value.code == "file-too-large"
    with pytest.raises(ProcessingError) as exc:
        run(tmp_path, PdfRotateOptions(angle=90), replace(Limits(), pdf_max_results_total_bytes=10))
    assert exc.value.code == "result-too-large"
    source.write_bytes(source.read_bytes()[:60])
    target = target_file(tmp_path / "damaged.pdf")
    with pytest.raises(ProcessingError) as exc:
        rotate(source, target, PdfRotateOptions(angle=90), Limits())
    assert exc.value.code == "parse-failed"


def test_sandboxed_cli_reports_details_and_errors(tmp_path: Path) -> None:
    source = tmp_path / "in.pdf"
    make_pdf(source, pages=2)
    target = target_file(tmp_path / "out.pdf")
    result_id = new_id()
    result = run_cli(
        ["run"],
        encode(request(source, {"tool": "pdf-rotate", "angle": 90}, [(result_id, None, target)])),
    )
    assert result.returncode == 0, result.stderr
    assert result.events[-1] == {
        "kind": "result",
        "id": result_id,
        "details": {"pageCount": 2, "rotatedPages": 2},
    }
    assert rotations(target) == [90, 90]
    bad_id = new_id()
    bad = target_file(tmp_path / "bad.pdf")
    failed = run_cli(
        ["run"],
        encode(
            request(
                source, {"tool": "pdf-rotate", "angle": 90, "pages": "5"}, [(bad_id, None, bad)]
            )
        ),
    )
    assert failed.events[-1] == {"kind": "error", "id": bad_id, "code": "invalid-options"}
    assert bad.stat().st_size == 0
