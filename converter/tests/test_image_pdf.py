"""image-pdf pipeline: ZIP bundle in, one PDF page per image out."""

from __future__ import annotations

import io
import zipfile
from dataclasses import replace
from pathlib import Path

import pikepdf
import pypdfium2 as pdfium  # type: ignore[import-untyped]
import pytest
from PIL import Image

from converter.errors import ProcessingError
from converter.limits import Limits
from converter.options import ImagePdfOptions
from converter.processing.imagepdf.pipeline import convert
from tests.helpers import target_file

RED, GREEN, BLUE = (255, 0, 0), (0, 200, 0), (0, 0, 255)
MM = 72 / 25.4
A4 = (595.28, 841.89)


def encoded(image: Image.Image, fmt: str, **kwargs: object) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format=fmt, **kwargs)
    return buffer.getvalue()


def solid(color: tuple[int, ...], size: tuple[int, int] = (40, 60)) -> Image.Image:
    return Image.new("RGB", size, color)


def bundle(
    tmp_path: Path,
    images: list[bytes],
    method: int = zipfile.ZIP_STORED,
    names: list[str] | None = None,
) -> Path:
    path = tmp_path / "bundle.zip"
    with zipfile.ZipFile(path, "w") as archive:
        for index, data in enumerate(images, start=1):
            name = names[index - 1] if names else f"{index:03d}.img"
            archive.writestr(zipfile.ZipInfo(name), data, compress_type=method)
    return path


def render(
    tmp_path: Path,
    images: list[bytes],
    options: ImagePdfOptions | None = None,
    limits: Limits | None = None,
    method: int = zipfile.ZIP_STORED,
    names: list[str] | None = None,
) -> tuple[Path, dict[str, object]]:
    source = bundle(tmp_path, images, method, names)
    destination = target_file(tmp_path / "result.pdf")
    details = convert(source, destination, options or ImagePdfOptions(), limits or Limits())
    return destination, details


def boxes(path: Path) -> list[tuple[float, float]]:
    with pikepdf.Pdf.open(path, attempt_recovery=False) as pdf:
        return [(float(p.MediaBox[2]), float(p.MediaBox[3])) for p in pdf.pages]


def center_pixel(path: Path, index: int) -> tuple[int, ...]:
    with pdfium.PdfDocument(path) as pdf:
        bitmap = pdf[index].render(scale=0.5).to_pil().convert("RGB")
    pixel = bitmap.getpixel((bitmap.width // 2, bitmap.height // 2))
    assert isinstance(pixel, tuple)
    return pixel


def close(a: tuple[int, ...], b: tuple[int, ...], tolerance: int = 12) -> bool:
    return all(abs(x - y) <= tolerance for x, y in zip(a, b, strict=True))


def first_image(pdf: pikepdf.Pdf, index: int = 0) -> pikepdf.Object:
    return next(iter(pdf.pages[index].Resources.XObject.values()))


def image_filters(path: Path) -> list[str]:
    with pikepdf.Pdf.open(path) as pdf:
        return [str(first_image(pdf, i).Filter) for i in range(len(pdf.pages))]


def test_one_page_per_image_in_bundle_order(tmp_path: Path) -> None:
    images = [encoded(solid(c), "PNG") for c in (RED, GREEN, BLUE)]
    path, details = render(tmp_path, images)
    assert details == {"pageCount": 3}
    assert boxes(path) == [pytest.approx(A4, abs=0.01)] * 3
    colors = [center_pixel(path, i) for i in range(3)]
    assert close(colors[0], RED)
    assert close(colors[1], GREEN)
    assert close(colors[2], BLUE)


def test_jpeg_is_embedded_without_recompression(tmp_path: Path) -> None:
    data = encoded(solid(RED, (64, 48)), "JPEG", quality=90)
    path, _ = render(tmp_path, [data])
    assert image_filters(path) == ["/DCTDecode"]
    with pikepdf.Pdf.open(path) as pdf:
        assert first_image(pdf).read_raw_bytes() == data


def test_other_formats_use_flate(tmp_path: Path) -> None:
    base = solid(GREEN, (30, 30))
    images = [encoded(base, f) for f in ("PNG", "GIF", "BMP", "WEBP")]
    path, details = render(tmp_path, images)
    assert details == {"pageCount": 4}
    assert image_filters(path) == ["/FlateDecode"] * 4
    assert all(close(center_pixel(path, i), GREEN, 20) for i in range(4))


def test_transparency_is_flattened_onto_white(tmp_path: Path) -> None:
    transparent = Image.new("RGBA", (40, 40), (255, 0, 0, 0))
    path, _ = render(tmp_path, [encoded(transparent, "PNG")])
    assert close(center_pixel(path, 0), (255, 255, 255))


def test_cmyk_jpeg_is_converted(tmp_path: Path) -> None:
    cmyk = Image.new("CMYK", (20, 20), (0, 255, 255, 0))
    path, _ = render(tmp_path, [encoded(cmyk, "JPEG")])
    assert image_filters(path) == ["/FlateDecode"]
    assert close(center_pixel(path, 0), RED, 60)


def test_exif_orientation_is_applied(tmp_path: Path) -> None:
    exif = Image.Exif()
    exif[274] = 6  # displayed rotated by 90 degrees: 80x20 becomes 20x80
    wide = encoded(solid(RED, (80, 20)), "JPEG", exif=exif)
    path, _ = render(tmp_path, [wide], ImagePdfOptions(page_size="fit", margin="none"))
    assert boxes(path) == [pytest.approx((15, 60), abs=0.01)]


@pytest.mark.parametrize(
    ("page_size", "orientation", "size", "expected"),
    [
        ("a4", "auto", (40, 60), A4),
        ("a4", "auto", (60, 40), A4[::-1]),
        ("a4", "auto", (50, 50), A4),
        ("a4", "landscape", (40, 60), A4[::-1]),
        ("a4", "portrait", (60, 40), A4),
        ("letter", "auto", (40, 60), (612, 792)),
        ("letter", "landscape", (40, 60), (792, 612)),
    ],
)
def test_page_size_and_orientation(
    tmp_path: Path,
    page_size: str,
    orientation: str,
    size: tuple[int, int],
    expected: tuple[float, float],
) -> None:
    options = ImagePdfOptions(page_size=page_size, orientation=orientation)
    path, _ = render(tmp_path, [encoded(solid(RED, size), "PNG")], options)
    assert boxes(path) == [pytest.approx(expected, abs=0.01)]


@pytest.mark.parametrize(("margin", "mm"), [("none", 0), ("small", 10), ("medium", 20)])
def test_fit_page_is_image_size_plus_margin(tmp_path: Path, margin: str, mm: int) -> None:
    options = ImagePdfOptions(page_size="fit", margin=margin)
    path, _ = render(tmp_path, [encoded(solid(RED, (200, 100)), "PNG")], options)
    pad = 2 * mm * MM
    assert boxes(path) == [pytest.approx((150 + pad, 75 + pad), abs=0.01)]


def test_image_is_centered_and_scaled_into_margins(tmp_path: Path) -> None:
    path, _ = render(
        tmp_path, [encoded(solid(RED, (10, 10)), "PNG")], ImagePdfOptions(margin="medium")
    )
    with pikepdf.Pdf.open(path) as pdf:
        values = pdf.pages[0].Contents.read_bytes().decode().split()
    # q <w> 0 0 <h> <x> <y> cm /Im0 Do Q
    width, height, x, y = (float(values[i]) for i in (1, 4, 5, 6))
    assert width == pytest.approx(A4[0] - 2 * 20 * MM, abs=0.01)
    assert height == pytest.approx(width, abs=0.01)
    assert x == pytest.approx(20 * MM, abs=0.01)
    assert y == pytest.approx((A4[1] - height) / 2, abs=0.01)


def test_error_codes(tmp_path: Path) -> None:
    png = encoded(solid(RED), "PNG")
    animated = io.BytesIO()
    frames = [solid(RED, (8, 8)), solid(BLUE, (8, 8))]
    frames[0].save(animated, format="GIF", save_all=True, append_images=frames[1:])
    cases: list[tuple[str, list[bytes], str, dict[str, object]]] = [
        ("animated", [png, animated.getvalue()], "animated-unsupported", {}),
        ("ico", [encoded(solid(RED, (16, 16)), "ICO")], "unsupported-type", {}),
        ("garbage", [b"not an image at all"], "unsupported-type", {}),
        ("corrupt", [png[:60] + b"\x00" * 40], "decode-failed", {}),
        ("compressed", [png], "decode-failed", {"method": zipfile.ZIP_DEFLATED}),
        ("names", [png], "decode-failed", {"names": ["bild.png"]}),
        ("gap", [png, png], "decode-failed", {"names": ["001.png", "003.png"]}),
        ("empty", [], "decode-failed", {}),
    ]
    for name, images, code, extra in cases:
        sub = tmp_path / name
        sub.mkdir()
        with pytest.raises(ProcessingError) as raised:
            render(sub, images, **extra)  # type: ignore[arg-type]
        assert raised.value.code == code, name


def test_not_a_zip(tmp_path: Path) -> None:
    source = tmp_path / "bundle.zip"
    source.write_bytes(b"plain text")
    destination = target_file(tmp_path / "out.pdf")
    with pytest.raises(ProcessingError) as raised:
        convert(source, destination, ImagePdfOptions(), Limits())
    assert raised.value.code == "decode-failed"


def test_limits(tmp_path: Path) -> None:
    png = encoded(solid(RED, (30, 30)), "PNG")
    base = Limits()
    cases = {
        "count": (replace(base, image_pdf_max_images=1), [png, png], "file-too-large"),
        "image": (replace(base, image_max_input_bytes=len(png) - 1), [png], "file-too-large"),
        "total": (
            replace(base, image_pdf_max_input_bytes=len(png) + 1),
            [png, png],
            "file-too-large",
        ),
        "pixels": (replace(base, image_max_pixels=100), [png], "dimensions-too-large"),
        "edge": (replace(base, image_max_edge=20), [png], "dimensions-too-large"),
        "output": (replace(base, image_max_output_bytes=200), [png], "result-too-large"),
    }
    for name, (limits, images, code) in cases.items():
        sub = tmp_path / name
        sub.mkdir()
        with pytest.raises(ProcessingError) as raised:
            render(sub, images, limits=limits)
        assert raised.value.code == code, name


def test_decompression_bomb_is_rejected(tmp_path: Path) -> None:
    # 12000 x 12000 = 144 MP of one color compresses to a small PNG.
    huge = encoded(Image.new("L", (12000, 12000)), "PNG")
    with pytest.raises(ProcessingError) as raised:
        render(tmp_path, [huge])
    assert raised.value.code == "dimensions-too-large"
