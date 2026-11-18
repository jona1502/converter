"""pdf-split: Seiteninhalt, ZIP-Aufbau, Grenzen und Fehlercodes mit unabhängigem Leser."""

from __future__ import annotations

import io
import json
import zipfile
from dataclasses import replace
from pathlib import Path

import pikepdf
import pypdfium2 as pdfium  # type: ignore[import-untyped]
import pytest
from pikepdf import Dictionary, Name, Pdf

from converter.errors import ProcessingError, ProtocolError
from converter.execute import execute
from converter.limits import Limits
from converter.options import SplitOptions, parse_options
from converter.processing.split.pipeline import convert, resolve
from converter.protocol import EventWriter, parse_request
from tests.helpers import encode, new_id, request, run_cli, target_file


def make_pdf(path: Path, pages: int) -> Path:
    """PDF, deren Seite n den Text ``Seite-n`` trägt."""
    with Pdf.new() as pdf:
        font = pdf.make_indirect(
            Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica)
        )
        for number in range(1, pages + 1):
            page = pdf.add_blank_page(page_size=(200, 200))
            page.Resources = Dictionary(Font=Dictionary(F1=font))
            content = f"BT /F1 12 Tf 10 100 Td (Seite-{number}) Tj ET"
            page.Contents = pdf.make_stream(content.encode())
        pdf.save(path)
    return path


def page_texts(data: bytes | Path) -> list[str]:
    with pdfium.PdfDocument(data) as pdf:
        return [page.get_textpage().get_text_range().strip() for page in pdf]


def options(**values: object) -> SplitOptions:
    parsed = parse_options({"tool": "pdf-split", **values})
    assert isinstance(parsed, SplitOptions)
    return parsed


def run(tmp_path: Path, pages: int, opts: SplitOptions) -> Path:
    source = make_pdf(tmp_path / "in.pdf", pages)
    destination = target_file(tmp_path / "out.bin")
    convert(source, destination, opts, Limits())
    return destination


def test_single_range_yields_one_pdf_with_selected_pages(tmp_path: Path) -> None:
    out = run(tmp_path, 6, options(mode="ranges", ranges="2-4"))
    assert out.read_bytes().startswith(b"%PDF-")
    assert page_texts(out) == ["Seite-2", "Seite-3", "Seite-4"]


def test_open_ended_range_runs_to_last_page(tmp_path: Path) -> None:
    out = run(tmp_path, 5, options(mode="ranges", ranges="4-"))
    assert page_texts(out) == ["Seite-4", "Seite-5"]


def test_multiple_ranges_yield_zip_in_input_order_with_ascii_names(tmp_path: Path) -> None:
    out = run(tmp_path, 8, options(mode="ranges", ranges="1-3,5,7-"))
    with zipfile.ZipFile(out) as archive:
        assert archive.namelist() == [
            "teil-01-seiten-1-3.pdf",
            "teil-02-seite-5.pdf",
            "teil-03-seiten-7-8.pdf",
        ]
        assert archive.testzip() is None
        parts = [page_texts(archive.read(name)) for name in archive.namelist()]
    assert parts == [["Seite-1", "Seite-2", "Seite-3"], ["Seite-5"], ["Seite-7", "Seite-8"]]


def test_overlapping_ranges_are_allowed(tmp_path: Path) -> None:
    out = run(tmp_path, 4, options(mode="ranges", ranges="1-3,2-4"))
    with zipfile.ZipFile(out) as archive:
        assert [len(page_texts(archive.read(n))) for n in archive.namelist()] == [3, 3]


def test_each_mode_yields_zip_even_for_one_page(tmp_path: Path) -> None:
    out = run(tmp_path, 1, options(mode="each"))
    with zipfile.ZipFile(out) as archive:
        assert archive.namelist() == ["seite-01.pdf"]
        assert page_texts(archive.read("seite-01.pdf")) == ["Seite-1"]


def test_each_mode_pads_names_and_keeps_page_order(tmp_path: Path) -> None:
    out = run(tmp_path, 12, options(mode="each"))
    with zipfile.ZipFile(out) as archive:
        names = archive.namelist()
        assert names[0] == "seite-01.pdf"
        assert names[-1] == "seite-12.pdf"
        texts = [page_texts(archive.read(n)) for n in names]
    assert texts == [[f"Seite-{i}"] for i in range(1, 13)]


def test_details_report_pages_and_parts(tmp_path: Path) -> None:
    source = make_pdf(tmp_path / "in.pdf", 5)
    target = target_file(tmp_path / "out")
    details = convert(source, target, options(mode="ranges", ranges="1,3-4"), Limits())
    assert details == {"pageCount": 5, "partCount": 2}


@pytest.mark.parametrize("spec", ["6", "1-6", "7-", "3-9"])
def test_ranges_outside_the_document_use_stable_code(tmp_path: Path, spec: str) -> None:
    source = make_pdf(tmp_path / "in.pdf", 5)
    target = target_file(tmp_path / "out")
    with pytest.raises(ProcessingError) as caught:
        convert(source, target, options(mode="ranges", ranges=spec), Limits())
    assert caught.value.code == "page-range-invalid"


def test_resolve_open_range_uses_page_count() -> None:
    assert resolve(options(mode="ranges", ranges="2-"), 4) == [(2, 4)]


def test_too_many_parts_are_rejected(tmp_path: Path) -> None:
    source = make_pdf(tmp_path / "in.pdf", 501)
    target = target_file(tmp_path / "out")
    with pytest.raises(ProcessingError) as caught:
        convert(source, target, options(mode="each"), Limits())
    assert caught.value.code == "page-range-invalid"


def test_encrypted_pdf_is_rejected(tmp_path: Path) -> None:
    source = tmp_path / "enc.pdf"
    with Pdf.new() as pdf:
        pdf.add_blank_page()
        pdf.save(source, encryption=pikepdf.Encryption(owner="o", user="u"))
    with pytest.raises(ProcessingError) as caught:
        convert(source, target_file(tmp_path / "out"), options(mode="each"), Limits())
    assert caught.value.code == "encrypted"


@pytest.mark.parametrize(
    ("data", "code"), [(b"hello", "not-pdf"), (b"%PDF-1.7\ngarbage", "parse-failed")]
)
def test_non_pdf_and_broken_pdf_are_rejected(tmp_path: Path, data: bytes, code: str) -> None:
    source = tmp_path / "in.pdf"
    source.write_bytes(data)
    with pytest.raises(ProcessingError) as caught:
        convert(source, target_file(tmp_path / "out"), options(mode="each"), Limits())
    assert caught.value.code == code


def test_input_and_output_limits(tmp_path: Path) -> None:
    source = make_pdf(tmp_path / "in.pdf", 3)
    small_input = replace(Limits(), pdf_max_input_bytes=source.stat().st_size - 1)
    with pytest.raises(ProcessingError) as caught:
        convert(source, target_file(tmp_path / "a"), options(mode="each"), small_input)
    assert caught.value.code == "file-too-large"
    small_output = replace(Limits(), pdf_max_results_total_bytes=500)
    for name, opts in [
        ("b", options(mode="each")),
        ("c", options(mode="ranges", ranges="1-3")),
    ]:
        with pytest.raises(ProcessingError) as caught:
            convert(source, target_file(tmp_path / name), opts, small_output)
        assert caught.value.code == "result-too-large"


def test_process_integration_emits_single_result_and_discards_on_error(tmp_path: Path) -> None:
    source = make_pdf(tmp_path / "in.pdf", 3)
    target = target_file(tmp_path / "out")
    result_id = new_id()
    body = request(source, {"tool": "pdf-split", "mode": "each"}, [(result_id, None, target)])
    output = io.BytesIO()
    execute(parse_request(encode(body)), EventWriter(output))
    events = [json.loads(line) for line in output.getvalue().splitlines()]
    assert events == [
        {"kind": "progress", "phase": "encode"},
        {"kind": "result", "id": result_id, "details": {"pageCount": 3, "partCount": 3}},
    ]
    bad_target = target_file(tmp_path / "bad")
    bad_id = new_id()
    bad = request(
        source, {"tool": "pdf-split", "mode": "ranges", "ranges": "9"}, [(bad_id, None, bad_target)]
    )
    output = io.BytesIO()
    execute(parse_request(encode(bad)), EventWriter(output))
    last = [json.loads(line) for line in output.getvalue().splitlines()][-1]
    assert last == {"kind": "error", "id": bad_id, "code": "page-range-invalid"}
    assert bad_target.stat().st_size == 0


def test_protocol_requires_one_target_without_level(tmp_path: Path) -> None:
    source = make_pdf(tmp_path / "in.pdf", 1)
    results: list[tuple[str, str | None, Path]] = [(new_id(), "high", target_file(tmp_path / "o"))]
    with pytest.raises(ProtocolError):
        parse_request(encode(request(source, {"tool": "pdf-split", "mode": "each"}, results)))


def test_cli_run_produces_pdf(tmp_path: Path) -> None:
    source = make_pdf(tmp_path / "in.pdf", 4)
    target = target_file(tmp_path / "out")
    result_id = new_id()
    body = request(
        source,
        {"tool": "pdf-split", "mode": "ranges", "ranges": "2-3"},
        [(result_id, None, target)],
    )
    result = run_cli(["run"], encode(body))
    assert result.returncode == 0, result.stderr
    assert result.events[-1] == {
        "kind": "result",
        "id": result_id,
        "details": {"pageCount": 4, "partCount": 1},
    }
    assert page_texts(target) == ["Seite-2", "Seite-3"]
