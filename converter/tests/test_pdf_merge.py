"""PDF-Zusammenführen: Bündelleser, Reihenfolge, Ablehnungen und Grenzen."""

from __future__ import annotations

import io
import struct
from dataclasses import replace
from pathlib import Path

import pikepdf
import pypdfium2 as pdfium  # type: ignore[import-untyped]
import pytest
from pikepdf import Name, Pdf

from converter.errors import ProcessingError
from converter.limits import Limits
from converter.processing.pdf_merge.bundle import MAGIC, read_bundle
from converter.processing.pdf_merge.pipeline import MAX_PAGES, merge
from tests.helpers import target_file

# Muss byte-gleich zu TestBundleMatchesGolden in server/internal/jobs sein.
GOLDEN = (
    MAGIC
    + struct.pack(">I", 6)
    + b"%PDF-a"
    + struct.pack(">I", 0)
    + struct.pack(">I", 7)
    + b"%PDF-bb"
    + struct.pack(">I", 0)
    + struct.pack(">I", 0)
)


def bundle(files: list[bytes], chunk: int = 65536) -> bytes:
    out = bytearray(MAGIC)
    for data in files:
        for start in range(0, len(data), chunk):
            part = data[start : start + chunk]
            out += struct.pack(">I", len(part)) + part
        out += struct.pack(">I", 0)
    return bytes(out + struct.pack(">I", 0))


def make_pdf(label: str, pages: int = 1, rotate: int = 0) -> bytes:
    pdf = Pdf.new()
    for number in range(1, pages + 1):
        page = pdf.add_blank_page(page_size=(200, 200))
        font = pdf.make_indirect(
            pikepdf.Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica)
        )
        page.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))
        page.Contents = pdf.make_stream(f"BT /F1 24 Tf 20 100 Td ({label}{number}) Tj ET".encode())
        if rotate:
            page.Rotate = rotate
    out = io.BytesIO()
    pdf.save(out)
    return out.getvalue()


def encrypted_pdf() -> bytes:
    pdf = Pdf.new()
    pdf.add_blank_page()
    out = io.BytesIO()
    pdf.save(out, encryption=pikepdf.Encryption(owner="o", user="u"))
    return out.getvalue()


def run(
    tmp_path: Path, files: list[bytes], limits: Limits | None = None
) -> tuple[Path, dict[str, object]]:
    source = tmp_path / "input"
    source.write_bytes(bundle(files))
    destination = target_file(tmp_path / "result.pdf")
    details = merge(source, destination, limits or Limits())
    return destination, details


def page_texts(path: Path) -> list[str]:
    with pdfium.PdfDocument(path) as pdf:
        return [page.get_textpage().get_text_range().strip() for page in pdf]


def test_merges_in_upload_order(tmp_path: Path) -> None:
    path, details = run(tmp_path, [make_pdf("B", 2), make_pdf("A"), make_pdf("C", 2)])
    assert details == {"pageCount": 5, "sourceCount": 3}
    assert page_texts(path) == ["B1", "B2", "A1", "C1", "C2"]
    with pikepdf.open(path) as merged:
        assert not merged.is_encrypted
        assert len(merged.pages) == 5


def test_rotation_and_inherited_page_size_survive(tmp_path: Path) -> None:
    inherited = Pdf.new()
    inherited.add_blank_page(page_size=(300, 400))
    pages = inherited.Root.Pages
    pages.MediaBox = pikepdf.Array([0, 0, 300, 400])
    del inherited.pages[0].obj["/MediaBox"]
    out = io.BytesIO()
    inherited.save(out)
    path, _ = run(tmp_path, [make_pdf("A", 1, rotate=90), out.getvalue()])
    with pikepdf.open(path) as merged:
        assert int(merged.pages[0].Rotate) == 90
        assert [float(v) for v in merged.pages[1].MediaBox] == [0, 0, 300, 400]


def test_same_file_twice_is_allowed(tmp_path: Path) -> None:
    same = make_pdf("S", 2)
    path, details = run(tmp_path, [same, same])
    assert details["pageCount"] == 4
    assert page_texts(path) == ["S1", "S2", "S1", "S2"]


def test_golden_bundle_reads_back() -> None:
    assert bundle([b"%PDF-a", b"%PDF-bb"]) == GOLDEN


def test_read_bundle_returns_files(tmp_path: Path) -> None:
    source = tmp_path / "b"
    source.write_bytes(bundle([b"%PDF-a", b"%PDF-" + b"x" * 70000], chunk=1000))
    files = read_bundle(source, 1_000_000)
    assert files[0] == b"%PDF-a" and len(files[1]) == 70005


def test_encrypted_input_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(ProcessingError) as info:
        run(tmp_path, [make_pdf("A"), encrypted_pdf()])
    assert info.value.code == "encrypted"
    assert (tmp_path / "result.pdf").stat().st_size == 0


def test_non_pdf_and_broken_pdf_are_rejected(tmp_path: Path) -> None:
    with pytest.raises(ProcessingError) as info:
        run(tmp_path, [make_pdf("A"), b"not a pdf at all"])
    assert info.value.code == "not-pdf"
    other = tmp_path / "broken"
    other.mkdir()
    with pytest.raises(ProcessingError) as info:
        run(other, [make_pdf("A"), make_pdf("B")[:200]])
    assert info.value.code == "parse-failed"


@pytest.mark.parametrize(
    "mutate",
    [
        lambda data: data[:-1],
        lambda data: data[:-4],
        lambda data: data + b"x",
        lambda data: b"WRONGMAGIC" + data[len(MAGIC) :],
        lambda data: MAGIC,
        lambda data: MAGIC + struct.pack(">I", 2**31) + b"xx",
    ],
)
def test_malformed_bundles_are_rejected(tmp_path: Path, mutate: object) -> None:
    source = tmp_path / "input"
    source.write_bytes(mutate(bundle([make_pdf("A"), make_pdf("B")])))  # type: ignore[operator]
    with pytest.raises(ProcessingError) as info:
        read_bundle(source, 10_000_000)
    assert info.value.code == "decode-failed"


def test_single_file_and_too_many_files_are_rejected(tmp_path: Path) -> None:
    source = tmp_path / "input"
    source.write_bytes(bundle([make_pdf("A")]))
    with pytest.raises(ProcessingError) as info:
        read_bundle(source, 10_000_000)
    assert info.value.code == "decode-failed"
    source.write_bytes(bundle([b"%PDF-"] * 21))
    with pytest.raises(ProcessingError) as info:
        read_bundle(source, 10_000_000)
    assert info.value.code == "decode-failed"
    source.write_bytes(bundle([b"%PDF-"] * 20))
    assert len(read_bundle(source, 10_000_000)) == 20


def test_total_input_limit_is_enforced_before_reading_everything(tmp_path: Path) -> None:
    source = tmp_path / "input"
    source.write_bytes(bundle([b"%PDF-" + b"x" * 500, b"%PDF-" + b"y" * 500]))
    with pytest.raises(ProcessingError) as info:
        read_bundle(source, 1000)
    assert info.value.code == "file-too-large"
    assert len(read_bundle(source, 1010)) == 2


def test_page_limit(tmp_path: Path) -> None:
    half = make_pdf("P", MAX_PAGES // 2 + 1)
    with pytest.raises(ProcessingError) as info:
        run(tmp_path, [half, half])
    assert info.value.code == "dimensions-too-large"
    assert (tmp_path / "result.pdf").stat().st_size == 0


def test_result_limit_discards_output(tmp_path: Path) -> None:
    files = [make_pdf("A", 3), make_pdf("B", 3)]
    limits = replace(Limits(), pdf_max_input_bytes=sum(len(f) for f in files))
    path, _ = run(tmp_path, files, limits)
    assert path.stat().st_size > 0
    other = tmp_path / "second"
    other.mkdir()
    # Ein Byte weniger Budget als Eingabe: schon der Bündelleser lehnt ab.
    with pytest.raises(ProcessingError) as info:
        run(other, files, replace(limits, pdf_max_input_bytes=limits.pdf_max_input_bytes - 1))
    assert info.value.code == "file-too-large"


def test_options_accept_only_the_tool_tag() -> None:
    from converter.errors import ProtocolError
    from converter.options import PdfMergeOptions, parse_options

    assert parse_options({"tool": "pdf-merge"}) == PdfMergeOptions()
    for bad in ({"tool": "pdf-merge", "levels": []}, {"tool": "pdf-merge", "order": [1, 0]}):
        with pytest.raises(ProtocolError):
            parse_options(bad)


def test_request_needs_exactly_one_result_without_level(tmp_path: Path) -> None:
    from converter.errors import ProtocolError
    from converter.protocol import parse_request
    from tests.helpers import encode, new_id, request

    source = tmp_path / "input"
    source.write_bytes(bundle([make_pdf("A"), make_pdf("B")]))
    one = target_file(tmp_path / "one.pdf")
    parsed = parse_request(encode(request(source, {"tool": "pdf-merge"}, [(new_id(), None, one)])))
    assert len(parsed.results) == 1
    two = target_file(tmp_path / "two.pdf")
    for results in ([(new_id(), "high", one)], [(new_id(), None, one), (new_id(), None, two)]):
        with pytest.raises(ProtocolError):
            parse_request(encode(request(source, {"tool": "pdf-merge"}, results)))


def test_cli_merges_and_reports_details(tmp_path: Path) -> None:
    from tests.helpers import encode, new_id, request, run_cli

    source = tmp_path / "input"
    source.write_bytes(bundle([make_pdf("A", 2), make_pdf("B")]))
    target = target_file(tmp_path / "output.pdf")
    result_id = new_id()
    result = run_cli(
        ["run"], encode(request(source, {"tool": "pdf-merge"}, [(result_id, None, target)]))
    )
    assert result.returncode == 0, result.stderr
    assert result.events[-1] == {
        "kind": "result",
        "id": result_id,
        "details": {"pageCount": 3, "sourceCount": 2},
    }
    assert page_texts(target) == ["A1", "A2", "B1"]


def test_cli_reports_encrypted_as_result_error(tmp_path: Path) -> None:
    from tests.helpers import encode, new_id, request, run_cli

    source = tmp_path / "input"
    source.write_bytes(bundle([make_pdf("A"), encrypted_pdf()]))
    target = target_file(tmp_path / "output.pdf")
    result_id = new_id()
    result = run_cli(
        ["run"], encode(request(source, {"tool": "pdf-merge"}, [(result_id, None, target)]))
    )
    assert result.events[-1] == {"kind": "error", "id": result_id, "code": "encrypted"}
    assert target.stat().st_size == 0
