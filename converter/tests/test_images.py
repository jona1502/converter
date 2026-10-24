"""Semantic conversion checks using actual encoded input and output pixels.

Portiert aus backend/tests/test_images.py; Ergebnisdateien legt der Test wie
der Go-Worker vorab an.
"""

import sys
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from PIL import Image

from converter.errors import ProcessingError
from converter.limits import Limits
from converter.options import ImageOptions, parse_options
from converter.probe import run_probe
from converter.processing.images.pipeline import convert
from tests.helpers import target_file


def options(**updates: Any) -> ImageOptions:
    parsed = parse_options({"tool": "image-convert", "format": "png", **updates})
    assert isinstance(parsed, ImageOptions)
    return parsed


@pytest.mark.parametrize("input_format", ["JPEG", "PNG", "WEBP", "GIF", "BMP", "ICO", "AVIF"])
@pytest.mark.parametrize("output_format", ["jpeg", "png", "webp", "bmp", "ico"])
def test_format_matrix(
    tmp_path: Path, limits: Limits, input_format: str, output_format: str
) -> None:
    source, target = tmp_path / "input", target_file(tmp_path / "output")
    Image.new("RGB", (32, 32), "red").save(source, format=input_format)
    details = convert(source, target, options(format=output_format), limits)
    with Image.open(target) as image:
        image.load()
        assert image.format and image.format.lower() == output_format
        assert image.size == ((256, 256) if output_format == "ico" else (32, 32))
    assert details["qualityApplied"] == (output_format in {"jpeg", "webp"})
    assert details["format"] == output_format


@pytest.mark.parametrize("output_format", ["jpeg", "bmp"])
def test_transparency_background(tmp_path: Path, limits: Limits, output_format: str) -> None:
    source, target = tmp_path / "input", target_file(tmp_path / "output")
    Image.new("RGBA", (10, 10), (255, 0, 0, 0)).save(source, format="PNG")
    details = convert(source, target, options(format=output_format, background="#00ff00"), limits)
    with Image.open(target) as image:
        pixel = image.convert("RGB").getpixel((4, 4))
        assert isinstance(pixel, tuple)
        assert pixel[0] < 5 and pixel[1] > 250 and pixel[2] < 5
    assert details["transparencyFlattened"]


@pytest.mark.parametrize(
    ("resize", "expected"),
    [
        ({"mode": "percent", "percent": 25, "allowUpscale": False}, (3, 2)),
        (
            {"mode": "dimensions", "width": 50, "keepAspectRatio": True, "allowUpscale": False},
            (10, 6),
        ),
        (
            {
                "mode": "dimensions",
                "width": 5,
                "height": 5,
                "keepAspectRatio": True,
                "allowUpscale": False,
            },
            (5, 3),
        ),
        (
            {
                "mode": "dimensions",
                "width": 20,
                "height": 4,
                "keepAspectRatio": False,
                "allowUpscale": False,
            },
            (10, 4),
        ),
        ({"mode": "maxEdge", "maxEdge": 5}, (5, 3)),
    ],
)
def test_resize(
    tmp_path: Path, limits: Limits, resize: dict[str, Any], expected: tuple[int, int]
) -> None:
    source, target = tmp_path / "input", target_file(tmp_path / "output")
    Image.new("RGB", (10, 6)).save(source, format="PNG")
    details = convert(source, target, options(resize=resize), limits)
    with Image.open(target) as image:
        assert image.size == expected
    assert not details["upscaled"]


def test_orientation_and_metadata(tmp_path: Path, limits: Limits) -> None:
    source, target = tmp_path / "input", target_file(tmp_path / "output")
    exif = Image.Exif()
    exif[274] = 6
    exif[270] = "private description"
    Image.new("RGB", (12, 8)).save(source, format="JPEG", exif=exif)
    details = convert(source, target, options(), limits)
    assert (details["sourceWidth"], details["sourceHeight"]) == (8, 12)
    with Image.open(target) as image:
        assert image.size == (8, 12)
        assert not image.getexif()


def test_animation_rejected(tmp_path: Path, limits: Limits) -> None:
    source = tmp_path / "input"
    Image.new("RGB", (10, 10), "red").save(
        source,
        format="PNG",
        save_all=True,
        append_images=[Image.new("RGB", (10, 10), "blue")],
        duration=100,
    )
    with pytest.raises(ProcessingError, match="animated-unsupported"):
        convert(source, target_file(tmp_path / "output"), options(), limits)


def test_limits_on_input_target_and_output(tmp_path: Path, limits: Limits) -> None:
    source = tmp_path / "input"
    Image.new("RGB", (10, 10)).save(source, format="PNG")
    for key, value, code in [
        ("image_max_input_bytes", 1, "file-too-large"),
        ("image_max_pixels", 50, "dimensions-too-large"),
        ("image_max_output_bytes", 1, "result-too-large"),
    ]:
        target = target_file(tmp_path / key)
        with pytest.raises(ProcessingError, match=code):
            convert(source, target, options(), replace(limits, **{key: value}))
        assert target.stat().st_size <= value
    with pytest.raises(ProcessingError, match="dimensions-too-large"):
        convert(
            source,
            target_file(tmp_path / "large"),
            options(
                resize={
                    "mode": "dimensions",
                    "width": 20_000,
                    "height": 20_000,
                    "keepAspectRatio": False,
                    "allowUpscale": True,
                }
            ),
            limits,
        )


def test_capabilities_actual_codecs() -> None:
    report = run_probe()
    assert report["inputFormats"] == ["jpeg", "png", "webp", "gif", "bmp", "ico", "avif"]
    assert report["outputFormats"] == ["jpeg", "png", "webp", "bmp", "ico"]
    assert report["pdf"] is True


def test_original_unsupported(tmp_path: Path, limits: Limits) -> None:
    source = tmp_path / "input"
    Image.new("RGB", (10, 10)).save(source, format="GIF")
    with pytest.raises(ProcessingError, match="original-format-unsupported"):
        convert(source, target_file(tmp_path / "output"), options(format="original"), limits)


@pytest.mark.parametrize("output_format", ["jpeg", "webp"])
def test_quality_changes_real_encoding(tmp_path: Path, limits: Limits, output_format: str) -> None:
    source = tmp_path / "input"
    image = Image.new("RGB", (128, 128))
    image.putdata(
        [
            ((x * 43 + y * 11) % 256, (x * 17 + y * 31) % 256, (x * 71 + y * 7) % 256)
            for y in range(128)
            for x in range(128)
        ]
    )
    image.save(source, format="PNG")
    low, high = target_file(tmp_path / "low"), target_file(tmp_path / "high")
    convert(source, low, options(format=output_format, quality=0.1), limits)
    convert(source, high, options(format=output_format, quality=0.95), limits)
    assert low.stat().st_size < high.stat().st_size


def test_png_quality_has_no_effect(tmp_path: Path, limits: Limits) -> None:
    source = tmp_path / "input"
    Image.new("RGBA", (32, 24), (10, 20, 30, 40)).save(source, format="PNG")
    low, high = target_file(tmp_path / "low"), target_file(tmp_path / "high")
    assert not convert(source, low, options(quality=0), limits)["qualityApplied"]
    convert(source, high, options(quality=1), limits)
    assert low.read_bytes() == high.read_bytes()
    with Image.open(low) as image:
        assert image.convert("RGBA").getpixel((2, 2)) == (10, 20, 30, 40)


def test_ico_sizes_and_centering(tmp_path: Path, limits: Limits) -> None:
    source, target = tmp_path / "input", target_file(tmp_path / "output")
    Image.new("RGBA", (64, 32), "red").save(source, format="PNG")
    details = convert(source, target, options(format="ico", icoSizes=[16, 64, 128]), limits)
    assert details["upscaled"]
    with Image.open(target) as image:
        assert image.info["sizes"] == {(16, 16), (64, 64), (128, 128)}
        corner = image.convert("RGBA").getpixel((0, 0))
        assert isinstance(corner, tuple) and corner[3] == 0
        assert image.convert("RGBA").getpixel((64, 64)) == (255, 0, 0, 255)
    roundtrip = target_file(tmp_path / "back")
    convert(target, roundtrip, options(), limits)
    with Image.open(roundtrip) as image:
        assert image.size == (128, 128)


def test_output_limit_applies_to_native_jpeg_writer(tmp_path: Path, limits: Limits) -> None:
    source, target = tmp_path / "input", target_file(tmp_path / "output")
    Image.new("RGB", (64, 64)).save(source, format="PNG")
    with pytest.raises(ProcessingError, match="result-too-large"):
        convert(source, target, options(format="jpeg"), replace(limits, image_max_output_bytes=32))
    assert target.stat().st_size <= 32


def test_target_is_never_created(tmp_path: Path, limits: Limits) -> None:
    """Der Konverter legt keine Dateien an; fehlt die Datei von Go, scheitert er."""
    source, target = tmp_path / "input", tmp_path / "missing"
    Image.new("RGB", (8, 8)).save(source, format="PNG")
    with pytest.raises(ProcessingError, match="encode-failed"):
        convert(source, target, options(), limits)
    assert not target.exists()


@pytest.mark.skipif(
    sys.platform != "linux",
    reason="O_NOFOLLOW gibt es unter Windows nicht; Zielplattform ist der Linux-Container",
)
def test_target_symlink_is_not_followed(tmp_path: Path, limits: Limits) -> None:
    source, victim, link = tmp_path / "input", tmp_path / "victim", tmp_path / "link"
    Image.new("RGB", (8, 8)).save(source, format="PNG")
    victim.write_bytes(b"keep")
    link.symlink_to(victim)
    with pytest.raises(ProcessingError, match="encode-failed"):
        convert(source, link, options(), limits)
    assert victim.read_bytes() == b"keep"
