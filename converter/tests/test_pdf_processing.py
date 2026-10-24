"""Real PDFs: image streams, document structure, parser and budgets.

Portiert aus backend/tests/test_pdf_processing.py. Abweichung: gescheiterte
Ergebnisse werden geleert statt gelöscht (Go besitzt die Datei).
"""

from __future__ import annotations

import io
import zlib
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name, Pdf
from PIL import Image

from converter.errors import ProcessingError
from converter.limits import Limits
from converter.processing.pdf.inspection import eff_dpi, inspect_document
from converter.processing.pdf.pipeline import analyze, compress
from tests.helpers import fixture_pdf, target_file


def _recorder(events: list[tuple[int, int]]) -> Callable[[int, int], None]:
    def record(current: int, total: int) -> None:
        events.append((current, total))

    return record


def test_real_pdf_analysis_and_three_levels_preserve_structure(
    tmp_path: Path, limits: Limits
) -> None:
    source = tmp_path / "input.pdf"
    fixture_pdf(source)
    analysis = analyze(source, limits)
    assert analysis["pageCount"] == 1
    assert analysis["images"]["total"] == 1  # shared image deduplicated
    assert analysis["images"]["recompressible"] == 1
    for level in ("high", "balanced", "small"):
        target = target_file(tmp_path / f"{level}.pdf")
        progress: list[tuple[int, int]] = []
        details = compress(source, target, level, limits, _recorder(progress))
        assert progress == [(0, 1), (1, 1)]
        assert details["originalSize"] == source.stat().st_size
        assert details["imagesRecompressed"] == 1
        with Pdf.open(target) as pdf:
            page = pdf.pages[0]
            assert list(page.MediaBox) == [0, 0, 612, 792]
            assert b"Preserved text" in page.Contents.read_bytes()
            assert str(page.Annots[0].A.URI) == "https://example.org"
            assert str(pdf.Root.AcroForm.Fields[0].V) == "Alice"
            with pdf.open_outline() as outline:
                assert outline.root[0].title == "Chapter"
            obj = page.Resources.XObject.Im
            assert obj.Filter == Name.DCTDecode
            with Image.open(io.BytesIO(obj.read_raw_bytes())) as image:
                assert image.size == (int(obj.Width), int(obj.Height))
            # Largest placement 288pt -> 150dpi; high keeps pixels, small downsizes.
            assert int(obj.Width) == (400 if level == "small" else 600)


def test_masks_unchanged(tmp_path: Path, limits: Limits) -> None:
    source, target = tmp_path / "masked.pdf", target_file(tmp_path / "out.pdf")
    fixture_pdf(source, mask=True)
    analysis = analyze(source, limits)
    assert analysis["images"]["skipped"] == {"mask": 1}
    details = compress(source, target, "small", limits, lambda *_: None)
    assert details["imagesSkipped"] == 1
    with Pdf.open(source) as original, Pdf.open(target) as result:
        assert (
            original.pages[0].Resources.XObject.Im.read_raw_bytes()
            == result.pages[0].Resources.XObject.Im.read_raw_bytes()
        )


@pytest.mark.parametrize("user", ["", "secret"])
def test_encryption_is_rejected(tmp_path: Path, limits: Limits, user: str) -> None:
    source = tmp_path / "encrypted.pdf"
    with Pdf.new() as pdf:
        pdf.add_blank_page()
        pdf.save(source, encryption=pikepdf.Encryption(owner="owner", user=user))
    with pytest.raises(ProcessingError) as exc:
        analyze(source, limits)
    assert exc.value.code == "encrypted"


def test_damaged_pdf_and_limits(tmp_path: Path, limits: Limits) -> None:
    source, target = tmp_path / "input.pdf", target_file(tmp_path / "out.pdf")
    fixture_pdf(source)
    with pytest.raises(ProcessingError) as exc:
        analyze(source, replace(limits, pdf_max_input_bytes=1))
    assert exc.value.code == "file-too-large"
    with pytest.raises(ProcessingError) as exc:
        compress(
            source, target, "high", replace(limits, pdf_max_results_total_bytes=10), lambda *_: None
        )
    assert exc.value.code == "result-too-large"
    assert target.stat().st_size == 0
    # Restbudget (output_limit) begrenzt ebenso.
    with pytest.raises(ProcessingError) as exc:
        compress(source, target, "high", limits, lambda *_: None, output_limit=10)
    assert exc.value.code == "result-too-large"
    assert target.stat().st_size == 0
    source.write_bytes(source.read_bytes()[:100])
    with pytest.raises(ProcessingError) as exc:
        analyze(source, limits)
    assert exc.value.code == "parse-failed"


def test_not_pdf(tmp_path: Path, limits: Limits) -> None:
    source = tmp_path / "input.pdf"
    source.write_bytes(b"GIF89a" + b"\x00" * 64)
    with pytest.raises(ProcessingError) as exc:
        analyze(source, limits)
    assert exc.value.code == "not-pdf"


def test_transforms_cycles_and_unknown_placement(tmp_path: Path) -> None:
    source = tmp_path / "matrix.pdf"
    fixture_pdf(source)
    with Pdf.open(source) as pdf:
        page = pdf.pages[0]
        image = page.Resources.XObject.Im
        form = page.Resources.XObject.Fm
        form.Matrix = Array([2, 0, 0, 0.5, 0, 0])
        form.write(b"q 100 0 0 100 0 0 cm /Im Do Q")
        page.Contents = pdf.make_stream(b"q 0.8 0.6 -0.6 0.8 0 0 cm /Fm Do Q")
        inspection = inspect_document(pdf)
        record = inspection.images[image.objgen]
        assert eff_dpi(record) == pytest.approx(min(600 * 72 / 200, 400 * 72 / 50))
        # Cycle includes a reachable image but no safe finite placement.
        form.Resources.XObject.Self = form
        form.write(b"/Self Do")
        inspection = inspect_document(pdf)
        assert eff_dpi(inspection.images[image.objgen]) is None


def test_png_predictor_reencoding_and_tiff_conservative(tmp_path: Path, limits: Limits) -> None:
    source, target = tmp_path / "predictor.pdf", target_file(tmp_path / "out.pdf")
    fixture_pdf(source)
    with Pdf.open(source) as pdf:
        obj = pdf.pages[0].Resources.XObject.Im
        raw = obj.read_bytes()
        stride = 600 * 3
        predicted = b"".join(b"\x00" + raw[y : y + stride] for y in range(0, len(raw), stride))
        obj.write(
            zlib.compress(predicted),
            filter=Name.FlateDecode,
            decode_parms=Dictionary(Predictor=15, Colors=3, BitsPerComponent=8, Columns=600),
        )
        pdf.save(tmp_path / "png.pdf")
    details = compress(tmp_path / "png.pdf", target, "small", limits, lambda *_: None)
    assert details["imagesRecompressed"] == 1
    with Pdf.open(tmp_path / "png.pdf") as pdf:
        pdf.pages[0].Resources.XObject.Im.DecodeParms.Predictor = 2
        pdf.save(tmp_path / "tiff.pdf")
    analysis = analyze(tmp_path / "tiff.pdf", limits)
    assert analysis["images"]["skipped"] == {"decode-parms": 1}


def test_independent_renderer_retains_text_and_page(tmp_path: Path, limits: Limits) -> None:
    import pypdfium2 as pdfium  # type: ignore[import-untyped]

    source, target = tmp_path / "render.pdf", target_file(tmp_path / "out.pdf")
    fixture_pdf(source)
    compress(source, target, "balanced", limits, lambda *_: None)
    document = pdfium.PdfDocument(str(target))
    page = document[0]
    text = page.get_textpage()
    bitmap = None
    try:
        assert "Preserved text" in text.get_text_range()
        bitmap = page.render(scale=0.5)
        assert bitmap.width == 306
        assert bitmap.height == 396
    finally:
        if bitmap is not None:
            bitmap.close()
        text.close()
        page.close()
        document.close()
