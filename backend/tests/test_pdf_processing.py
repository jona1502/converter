"""Real PDFs: image streams, document structure, parser and budgets."""

from __future__ import annotations

import io
import random
import zlib
from collections.abc import Callable
from pathlib import Path

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name, Pdf, String
from PIL import Image

from app.core.config import Settings
from app.processing.errors import ProcessingError
from app.processing.pdf.pipeline import analyze, compress


def fixture_pdf(path: Path, mask: bool = False) -> None:
    with Pdf.new() as pdf:
        page = pdf.add_blank_page(page_size=(612, 792))
        image = Image.frombytes("RGB", (600, 400), random.Random(12).randbytes(600 * 400 * 3))  # noqa: S311 - fixture noise
        obj = pdf.make_stream(zlib.compress(image.tobytes()))
        obj.Filter = Name.FlateDecode
        obj.Type, obj.Subtype = Name.XObject, Name.Image
        obj.Width, obj.Height, obj.BitsPerComponent = 600, 400, 8
        obj.ColorSpace = Name.DeviceRGB
        if mask:
            obj.SMask = pdf.make_stream(b"mask")
        font = pdf.make_indirect(
            Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica)
        )
        form = pdf.make_stream(b"q 144 0 0 96 0 0 cm /Im Do Q")
        form.Type, form.Subtype = Name.XObject, Name.Form
        form.BBox = Array([0, 0, 144, 96])
        form.Resources = Dictionary(XObject=Dictionary(Im=obj))
        page.Resources = Dictionary(XObject=Dictionary(Fm=form, Im=obj), Font=Dictionary(F1=font))
        page.Contents = pdf.make_stream(
            b"BT /F1 12 Tf 10 700 Td (Preserved text) Tj ET /Fm Do q 288 0 0 192 0 0 cm /Im Do Q"
        )
        page.Annots = Array(
            [
                pdf.make_indirect(
                    Dictionary(
                        Type=Name.Annot,
                        Subtype=Name.Link,
                        Rect=Array([0, 0, 100, 100]),
                        A=Dictionary(S=Name.URI, URI=String("https://example.org")),
                    )
                )
            ]
        )
        pdf.Root.AcroForm = Dictionary(
            Fields=Array(
                [pdf.make_indirect(Dictionary(FT=Name.Tx, T=String("name"), V=String("Alice")))]
            )
        )
        with pdf.open_outline() as outline:
            outline.root.append(pikepdf.OutlineItem("Chapter", 0))
        pdf.save(path)


def _recorder(events: list[tuple[int, int]]) -> Callable[[int, int], None]:
    def record(current: int, total: int) -> None:
        events.append((current, total))

    return record


def test_real_pdf_analysis_and_three_levels_preserve_structure(
    tmp_path: Path, settings: Settings
) -> None:
    source = tmp_path / "input.pdf"
    fixture_pdf(source)
    analysis = analyze(source, settings)
    assert analysis["pageCount"] == 1
    assert analysis["images"]["total"] == 1  # shared image deduplicated
    assert analysis["images"]["recompressible"] == 1
    for level in ("high", "balanced", "small"):
        target = tmp_path / f"{level}.pdf"
        progress: list[tuple[int, int]] = []
        details = compress(source, target, level, settings, _recorder(progress))
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


def test_masks_unchanged(tmp_path: Path, settings: Settings) -> None:
    source, target = tmp_path / "masked.pdf", tmp_path / "out.pdf"
    fixture_pdf(source, mask=True)
    analysis = analyze(source, settings)
    assert analysis["images"]["skipped"] == {"mask": 1}
    details = compress(source, target, "small", settings, lambda *_: None)
    assert details["imagesSkipped"] == 1
    with Pdf.open(source) as original, Pdf.open(target) as result:
        assert (
            original.pages[0].Resources.XObject.Im.read_raw_bytes()
            == result.pages[0].Resources.XObject.Im.read_raw_bytes()
        )


@pytest.mark.parametrize("user", ["", "secret"])
def test_encryption_is_rejected(tmp_path: Path, settings: Settings, user: str) -> None:
    source = tmp_path / "encrypted.pdf"
    with Pdf.new() as pdf:
        pdf.add_blank_page()
        pdf.save(source, encryption=pikepdf.Encryption(owner="owner", user=user))
    with pytest.raises(ProcessingError) as exc:
        analyze(source, settings)
    assert exc.value.code == "encrypted"


def test_damaged_pdf_and_limits(tmp_path: Path, settings: Settings) -> None:
    source, target = tmp_path / "input.pdf", tmp_path / "out.pdf"
    fixture_pdf(source)
    low_input = settings.model_copy(update={"pdf_max_input_bytes": 1})
    with pytest.raises(ProcessingError) as exc:
        analyze(source, low_input)
    assert exc.value.code == "file-too-large"
    low_output = settings.model_copy(update={"pdf_max_results_total_bytes": 10})
    with pytest.raises(ProcessingError) as exc:
        compress(source, target, "high", low_output, lambda *_: None)
    assert exc.value.code == "result-too-large"
    assert not target.exists()
    source.write_bytes(source.read_bytes()[:100])
    with pytest.raises(ProcessingError) as exc:
        analyze(source, settings)
    assert exc.value.code == "parse-failed"


def test_transforms_cycles_and_unknown_placement(tmp_path: Path, settings: Settings) -> None:
    from app.processing.pdf.inspection import eff_dpi, inspect_document

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


def test_png_predictor_reencoding_and_tiff_conservative(tmp_path: Path, settings: Settings) -> None:
    source, target = tmp_path / "predictor.pdf", tmp_path / "out.pdf"
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
    details = compress(tmp_path / "png.pdf", target, "small", settings, lambda *_: None)
    assert details["imagesRecompressed"] == 1
    with Pdf.open(tmp_path / "png.pdf") as pdf:
        pdf.pages[0].Resources.XObject.Im.DecodeParms.Predictor = 2
        pdf.save(tmp_path / "tiff.pdf")
    analysis = analyze(tmp_path / "tiff.pdf", settings)
    assert analysis["images"]["skipped"] == {"decode-parms": 1}


def test_independent_renderer_retains_text_and_page(tmp_path: Path, settings: Settings) -> None:
    import pypdfium2 as pdfium  # type: ignore[import-untyped]

    source, target = tmp_path / "render.pdf", tmp_path / "out.pdf"
    fixture_pdf(source)
    compress(source, target, "balanced", settings, lambda *_: None)
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
