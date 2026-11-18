"""PDF zu Bild: echte Rundreisen mit unabhängiger Prüfung der Bilder."""

from __future__ import annotations

import io
import zipfile
from dataclasses import replace
from pathlib import Path

import pikepdf
import pytest
from PIL import Image

from converter.errors import ProcessingError
from converter.limits import Limits
from converter.options import PdfImageOptions
from tests.helpers import target_file

COLORS = [(1, 0, 0), (0, 1, 0), (0, 0, 1), (1, 1, 0)]


def make_pdf(
    path: Path,
    pages: int = 1,
    size: tuple[float, float] = (200, 100),
    rotate: int = 0,
    encryption: pikepdf.Encryption | None = None,
) -> Path:
    """Jede Seite füllt sich mit einer eigenen Farbe (rot, grün, blau, gelb, ...)."""
    with pikepdf.Pdf.new() as pdf:
        for index in range(pages):
            page = pdf.add_blank_page(page_size=size)
            r, g, b = COLORS[index % len(COLORS)]
            page.Contents = pdf.make_stream(f"{r} {g} {b} rg 0 0 {size[0]} {size[1]} re f".encode())
            if rotate:
                page.Rotate = rotate
        if encryption:
            pdf.save(path, encryption=encryption)
        else:
            pdf.save(path)
    return path


def run(
    tmp_path: Path,
    source: Path,
    options: PdfImageOptions,
    limits: Limits | None = None,
    name: str = "result.bin",
) -> tuple[Path, dict[str, object], list[tuple[int, int]]]:
    from converter.processing.pdfimage.pipeline import convert

    destination = target_file(tmp_path / name)
    events: list[tuple[int, int]] = []
    details = convert(
        source, destination, options, limits or Limits(), lambda c, t: events.append((c, t))
    )
    return destination, details, events


def center(image: Image.Image) -> tuple[int, ...]:
    pixel = image.convert("RGB").getpixel((image.width // 2, image.height // 2))
    assert isinstance(pixel, tuple)
    return pixel


def close(actual: tuple[int, ...], expected: tuple[int, ...], tolerance: int = 12) -> bool:
    return all(abs(a - b) <= tolerance for a, b in zip(actual, expected, strict=True))


@pytest.mark.parametrize("fmt", ["png", "jpeg", "webp"])
def test_single_page_is_one_image_at_the_requested_dpi(tmp_path: Path, fmt: str) -> None:
    source = make_pdf(tmp_path / "in.pdf", pages=2)
    destination, details, events = run(
        tmp_path, source, PdfImageOptions(format=fmt, dpi=144, pages=(2,))
    )
    with Image.open(destination) as image:
        assert (image.format or "").lower() == fmt
        # 200 x 100 pt bei 144 dpi = 400 x 200 px; Seite 2 ist grün.
        assert image.size == (400, 200)
        assert close(center(image), (0, 255, 0))
    assert details == {"pageCount": 1, "sourcePageCount": 2, "archive": False}
    assert events[-1] == (1, 1)


def test_several_pages_become_a_zip_of_ordered_images(tmp_path: Path) -> None:
    source = make_pdf(tmp_path / "in.pdf", pages=3)
    destination, details, events = run(
        tmp_path, source, PdfImageOptions(format="png", dpi=72, pages=(1, 3))
    )
    assert details == {"pageCount": 2, "sourcePageCount": 3, "archive": True}
    with zipfile.ZipFile(destination) as archive:
        assert archive.testzip() is None
        assert archive.namelist() == ["seite-001.png", "seite-003.png"]
        first = Image.open(io.BytesIO(archive.read("seite-001.png")))
        third = Image.open(io.BytesIO(archive.read("seite-003.png")))
        assert first.size == (200, 100)
        assert close(center(first), (255, 0, 0))
        assert close(center(third), (0, 0, 255))
    assert events[0] == (0, 2) and events[-1] == (2, 2)


def test_all_pages_make_a_zip_even_for_one_page(tmp_path: Path) -> None:
    source = make_pdf(tmp_path / "in.pdf", pages=1)
    destination, details, _ = run(tmp_path, source, PdfImageOptions(format="jpeg"))
    assert details == {"pageCount": 1, "sourcePageCount": 1, "archive": True}
    with zipfile.ZipFile(destination) as archive:
        assert archive.namelist() == ["seite-001.jpg"]


def test_rotation_is_applied(tmp_path: Path) -> None:
    source = make_pdf(tmp_path / "in.pdf", rotate=90)
    destination, _, _ = run(tmp_path, source, PdfImageOptions(format="png", dpi=72, pages=(1,)))
    with Image.open(destination) as image:
        assert image.size == (100, 200)


def test_pixel_limit_is_checked_before_rendering(tmp_path: Path) -> None:
    source = make_pdf(tmp_path / "in.pdf", pages=2, size=(612, 792))
    limits = replace(Limits(), pdf_image_max_pixels=100_000)
    # 612 x 792 pt bei 72 dpi sind 484 704 Pixel.
    with pytest.raises(ProcessingError) as exc:
        run(tmp_path, source, PdfImageOptions(format="png", dpi=72, pages=(1,)), limits)
    assert exc.value.code == "dimensions-too-large"
    ok = replace(Limits(), pdf_image_max_pixels=484_704)
    run(tmp_path, source, PdfImageOptions(format="png", dpi=72, pages=(1,)), ok, "ok.bin")


def test_edge_limit_follows_the_webp_maximum(tmp_path: Path) -> None:
    source = make_pdf(tmp_path / "in.pdf", size=(14400, 20))
    # 14 400 pt bei 300 dpi = 60 000 Pixel Kantenlänge, knapp 1,2 Mio. Pixel.
    with pytest.raises(ProcessingError) as exc:
        run(tmp_path, source, PdfImageOptions(format="png", dpi=300, pages=(1,)))
    assert exc.value.code == "dimensions-too-large"


def test_page_cap_and_out_of_range_selection(tmp_path: Path) -> None:
    source = make_pdf(tmp_path / "in.pdf", pages=3)
    capped = replace(Limits(), pdf_render_max_pages=2)
    with pytest.raises(ProcessingError) as exc:
        run(tmp_path, source, PdfImageOptions(format="png"), capped)
    assert exc.value.code == "result-too-large"
    with pytest.raises(ProcessingError) as exc:
        run(tmp_path, source, PdfImageOptions(format="png", pages=(2, 4)), name="o2.bin")
    assert exc.value.code == "parse-failed"
    # Eine zulässige Teilauswahl bleibt trotz kleiner Obergrenze möglich.
    run(tmp_path, source, PdfImageOptions(format="png", pages=(1, 3)), capped, "subset.bin")


def test_output_budget_is_enforced(tmp_path: Path) -> None:
    source = make_pdf(tmp_path / "in.pdf", pages=2)
    limits = replace(Limits(), pdf_max_results_total_bytes=100)
    with pytest.raises(ProcessingError) as exc:
        run(tmp_path, source, PdfImageOptions(format="png", dpi=300), limits)
    assert exc.value.code == "result-too-large"


@pytest.mark.parametrize("user", ["", "secret"])
def test_encrypted_pdfs_are_rejected(tmp_path: Path, user: str) -> None:
    source = make_pdf(tmp_path / "enc.pdf", encryption=pikepdf.Encryption(owner="owner", user=user))
    with pytest.raises(ProcessingError) as exc:
        run(tmp_path, source, PdfImageOptions(format="png"))
    assert exc.value.code == "encrypted"


def test_damaged_and_foreign_files_are_rejected(tmp_path: Path) -> None:
    broken = tmp_path / "broken.pdf"
    broken.write_bytes(b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n")
    with pytest.raises(ProcessingError) as exc:
        run(tmp_path, broken, PdfImageOptions(format="png"))
    assert exc.value.code == "parse-failed"
    other = tmp_path / "text.pdf"
    other.write_bytes(b"not a pdf at all")
    with pytest.raises(ProcessingError) as exc:
        run(tmp_path, other, PdfImageOptions(format="png"), name="o2.bin")
    assert exc.value.code == "not-pdf"
    big = make_pdf(tmp_path / "big.pdf")
    small = replace(Limits(), pdf_max_input_bytes=10)
    with pytest.raises(ProcessingError) as exc:
        run(tmp_path, big, PdfImageOptions(format="png"), small, "o3.bin")
    assert exc.value.code == "file-too-large"


def test_quality_changes_jpeg_size(tmp_path: Path) -> None:
    source = tmp_path / "in.pdf"
    # Viele farbige Linien, damit die Qualität die Dateigröße messbar beeinflusst.
    with pikepdf.Pdf.new() as pdf:
        page = pdf.add_blank_page(page_size=(300, 300))
        lines = "".join(
            f"{i % 7 / 7} {i % 5 / 5} {i % 3 / 3} RG {i} 0 m 300 {i} l S " for i in range(0, 300, 3)
        )
        page.Contents = pdf.make_stream(lines.encode())
        pdf.save(source)
    low, _, _ = run(tmp_path, source, PdfImageOptions(format="jpeg", quality=0.1, pages=(1,)))
    high, _, _ = run(
        tmp_path, source, PdfImageOptions(format="jpeg", quality=0.95, pages=(1,)), name="h.bin"
    )
    assert low.stat().st_size < high.stat().st_size
