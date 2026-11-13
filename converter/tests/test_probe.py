"""Capabilities-Probe als echter Kindprozess (unter Linux mit Sandbox)."""

from __future__ import annotations

import json

import numpy as np
import pikepdf
import PIL
import soundfile as sf

from tests.helpers import run_cli


def test_cli_probe_reports_all_required_formats() -> None:
    result = run_cli(["probe"])
    assert result.returncode == 0, result.stderr
    lines = result.stdout.splitlines()
    assert len(lines) == 1
    report = json.loads(lines[0])
    assert report == {
        "protocolVersion": 1,
        "inputFormats": ["jpeg", "png", "webp", "gif", "bmp", "ico", "avif"],
        "outputFormats": ["jpeg", "png", "webp", "bmp", "ico"],
        "pdf": True,
        "audio": {
            "inputFormats": ["mp3", "wav", "flac", "ogg"],
            "outputFormats": ["mp3", "wav", "flac", "ogg"],
        },
        "versions": {
            "python": report["versions"]["python"],
            "pillow": PIL.__version__,
            "pikepdf": pikepdf.__version__,
            "qpdf": pikepdf.__libqpdf_version__,
            "soundfile": sf.__version__,
            "libsndfile": sf.__libsndfile_version__,
            "numpy": np.__version__,
        },
    }
    assert report["versions"]["python"].startswith("3.13.")
    assert (PIL.__version__, pikepdf.__version__) == ("13.0.0", "10.17.0")
    assert (sf.__version__, np.__version__) == ("0.14.0", "2.5.4")
    # MP3 setzt libsndfile >= 1.1 voraus.
    major, minor = (int(part) for part in sf.__libsndfile_version__.split(".")[:2])
    assert (major, minor) >= (1, 1)
