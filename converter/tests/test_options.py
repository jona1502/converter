"""Strikte Optionsprüfung ohne pydantic (Regeln wie backend/app/schemas/options.py)."""

from __future__ import annotations

import json
from typing import Any

import pytest

from converter.errors import ProtocolError
from converter.options import (
    AudioOptions,
    ImageOptions,
    PdfOptions,
    ResizeDimensions,
    ResizeMaxEdge,
    ResizeNone,
    ResizePercent,
    parse_options,
)

IMAGE = {"tool": "image-convert", "format": "webp"}


def test_image_defaults() -> None:
    options = parse_options(IMAGE)
    assert options == ImageOptions(tool="image-convert", format="webp")
    assert isinstance(options, ImageOptions)
    assert options.quality == 0.85
    assert options.background == "#ffffff"
    assert options.resize == ResizeNone()
    assert options.ico_sizes is None
    assert options.effective_ico_sizes() == [16, 32, 48, 256]


def test_full_image_options() -> None:
    options = parse_options(
        {
            "tool": "image-resize",
            "format": "original",
            "quality": 0,
            "background": "#A0b1C2",
            "resize": {"mode": "percent", "percent": 150, "allowUpscale": True},
            "icoSizes": [256, 16],
        }
    )
    assert isinstance(options, ImageOptions)
    assert options.quality == 0.0  # 0 ist gültig und kein fehlender Wert
    assert options.resize == ResizePercent(percent=150.0, allow_upscale=True)
    assert options.effective_ico_sizes() == [256, 16]
    assert options.output_format("png") == "png"
    assert options.output_format("gif") is None


@pytest.mark.parametrize(
    ("resize", "expected"),
    [
        ({"mode": "none"}, ResizeNone()),
        ({"mode": "maxEdge", "maxEdge": 5}, ResizeMaxEdge(5)),
        (
            {"mode": "dimensions", "width": 5, "keepAspectRatio": True, "allowUpscale": False},
            ResizeDimensions(5, None, keep_aspect_ratio=True, allow_upscale=False),
        ),
        (
            {
                "mode": "dimensions",
                "width": None,
                "height": 7,
                "keepAspectRatio": True,
                "allowUpscale": True,
            },
            ResizeDimensions(None, 7, keep_aspect_ratio=True, allow_upscale=True),
        ),
    ],
)
def test_resize_variants(resize: dict[str, Any], expected: object) -> None:
    options = parse_options({**IMAGE, "resize": resize})
    assert isinstance(options, ImageOptions)
    assert options.resize == expected


def test_pdf_defaults_and_order() -> None:
    assert parse_options({"tool": "pdf-compress"}) == PdfOptions(("high", "balanced", "small"))
    assert parse_options({"tool": "pdf-compress", "levels": ["small", "high"]}) == PdfOptions(
        ("small", "high")
    )


@pytest.mark.parametrize(
    "value",
    [
        None,
        [],
        {"tool": "image-convert"},
        {"tool": "video", "format": "png"},
        {**IMAGE, "unknown": 1},
        {**IMAGE, "ico_sizes": [16]},
        {**IMAGE, "format": "gif"},
        {**IMAGE, "format": "JPEG"},
        {**IMAGE, "quality": "0.5"},
        {**IMAGE, "quality": True},
        {**IMAGE, "quality": None},
        {**IMAGE, "quality": 1.01},
        {**IMAGE, "quality": -0.01},
        {**IMAGE, "background": "#fff"},
        {**IMAGE, "background": "#ffffff\n"},
        {**IMAGE, "background": "ffffff"},
        {**IMAGE, "background": None},
        {**IMAGE, "resize": None},
        {**IMAGE, "resize": {"mode": "none", "percent": 5}},
        {**IMAGE, "resize": {"mode": "zoom"}},
        {**IMAGE, "resize": {"mode": "percent", "percent": 0, "allowUpscale": True}},
        {**IMAGE, "resize": {"mode": "percent", "percent": 101, "allowUpscale": False}},
        {**IMAGE, "resize": {"mode": "percent", "percent": 50}},
        {**IMAGE, "resize": {"mode": "maxEdge", "maxEdge": 0}},
        {**IMAGE, "resize": {"mode": "maxEdge", "maxEdge": 5.0}},
        {**IMAGE, "resize": {"mode": "maxEdge", "maxEdge": True}},
        {**IMAGE, "resize": {"mode": "dimensions", "keepAspectRatio": True, "allowUpscale": True}},
        {
            **IMAGE,
            "resize": {
                "mode": "dimensions",
                "width": 5,
                "keepAspectRatio": False,
                "allowUpscale": True,
            },
        },
        {**IMAGE, "format": "ico", "resize": {"mode": "maxEdge", "maxEdge": 5}},
        {**IMAGE, "icoSizes": [16]},
        {**IMAGE, "format": "ico", "icoSizes": []},
        {**IMAGE, "format": "ico", "icoSizes": [16, 16]},
        {**IMAGE, "format": "ico", "icoSizes": [24]},
        {**IMAGE, "format": "ico", "icoSizes": [16.0]},
        {"tool": "pdf-compress", "levels": []},
        {"tool": "pdf-compress", "levels": None},
        {"tool": "pdf-compress", "levels": ["high", "high"]},
        {"tool": "pdf-compress", "levels": ["tiny"]},
        {"tool": "pdf-compress", "format": "png"},
    ],
)
def test_invalid_options(value: object) -> None:
    with pytest.raises(ProtocolError) as exc:
        parse_options(value)
    assert exc.value.code == "invalid-options"
    # Begründungen enthalten nie Eingabewerte.
    assert "#fff" not in exc.value.reason and "zoom" not in exc.value.reason


def test_json_numbers_keep_their_type() -> None:
    # 50.0 ist in JSON eine Gleitkommazahl und keine gültige Pixelangabe.
    raw = json.loads('{"mode":"maxEdge","maxEdge":50.0}')
    with pytest.raises(ProtocolError):
        parse_options({**IMAGE, "resize": raw})
    # Ganzzahlen sind als Prozent/Qualität zulässig.
    options = parse_options({**IMAGE, "quality": 1})
    assert isinstance(options, ImageOptions) and options.quality == 1.0


# --- Audio ----------------------------------------------------------------------


def test_audio_option_defaults() -> None:
    parsed = parse_options({"tool": "audio-convert", "format": "mp3"})
    assert parsed == AudioOptions(format="mp3", quality=0.8, channels="original")


@pytest.mark.parametrize(
    "value",
    [
        {"tool": "audio-convert"},
        {"tool": "audio-convert", "format": "m4a"},
        {"tool": "audio-convert", "format": "MP3"},
        {"tool": "audio-convert", "format": "original"},
        {"tool": "audio-convert", "format": "mp3", "quality": 1.5},
        {"tool": "audio-convert", "format": "mp3", "quality": "0.5"},
        {"tool": "audio-convert", "format": "mp3", "quality": None},
        {"tool": "audio-convert", "format": "mp3", "channels": "stereo"},
        {"tool": "audio-convert", "format": "mp3", "channels": None},
        {"tool": "audio-convert", "format": "mp3", "sampleRate": 44100},
        {"tool": "audio-convert", "format": "mp3", "resize": {"mode": "none"}},
    ],
)
def test_invalid_audio_options(value: object) -> None:
    with pytest.raises(ProtocolError) as exc:
        parse_options(value)
    assert exc.value.code == "invalid-options"
