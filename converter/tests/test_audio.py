"""Audio-Pipeline: echte Rundreisen kleiner, generierter Sinusdateien.

Alle Eingaben werden mit soundfile erzeugt und alle Ergebnisse unabhängig
mit soundfile erneut dekodiert. Ergebnisdateien legt der Test wie der
Go-Worker vorab an.
"""

from __future__ import annotations

import io
from dataclasses import replace
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import soundfile as sf

from converter.errors import ProcessingError
from converter.limits import Limits
from converter.options import AudioOptions, parse_options
from converter.processing.audio import pipeline
from converter.processing.audio.pipeline import convert
from tests.helpers import target_file

RATE = 44_100
SECONDS = 0.3
# soundfile-Format/Subtyp je Eingabeformat der Tests.
WRITE = {
    "mp3": ("MP3", "MPEG_LAYER_III"),
    "wav": ("WAV", "PCM_16"),
    "flac": ("FLAC", "PCM_16"),
    "ogg": ("OGG", "VORBIS"),
}
CONTAINER = {"mp3": "MP3", "wav": "WAV", "flac": "FLAC", "ogg": "OGG"}


def sine(channels: int = 2, rate: int = RATE, seconds: float = SECONDS) -> np.ndarray:
    t = np.arange(int(rate * seconds)) / rate
    columns = [0.5 * np.sin(2 * np.pi * 440 * (i + 1) * t) for i in range(channels)]
    return np.stack(columns, axis=1)


def write_input(
    path: Path,
    fmt: str,
    channels: int = 2,
    rate: int = RATE,
    seconds: float = SECONDS,
    subtype: str | None = None,
) -> None:
    container, default = WRITE[fmt]
    sf.write(
        path,
        sine(channels, rate, seconds),
        rate,
        format=container,
        subtype=subtype or default,
    )


def options(**updates: Any) -> AudioOptions:
    parsed = parse_options({"tool": "audio-convert", "format": "wav", **updates})
    assert isinstance(parsed, AudioOptions)
    return parsed


def run(tmp_path: Path, limits: Limits, **updates: Any) -> tuple[dict[str, Any], Path]:
    target = target_file(tmp_path / "output")
    details = convert(tmp_path / "input", target, options(**updates), limits)
    return details, target


# --- Rundreisen ---------------------------------------------------------------


@pytest.mark.parametrize("input_format", ["mp3", "wav", "flac", "ogg"])
@pytest.mark.parametrize("output_format", ["mp3", "wav", "flac", "ogg"])
def test_format_matrix(
    tmp_path: Path, limits: Limits, input_format: str, output_format: str
) -> None:
    write_input(tmp_path / "input", input_format)
    details, target = run(tmp_path, limits, format=output_format)
    info = sf.info(target)
    assert info.format == CONTAINER[output_format]
    assert (info.samplerate, info.channels) == (RATE, 2)
    # Verlustbehaftete Codecs verschieben die Länge höchstens minimal.
    assert abs(info.frames - RATE * SECONDS) < RATE * 0.06
    data, _ = sf.read(target, always_2d=True)
    # Signal überlebt (keine Stille, kein Übersteuern).
    assert 0.3 < float(np.max(np.abs(data))) <= 1.0
    assert details == {
        "format": output_format,
        "durationSeconds": details["durationSeconds"],
        "sampleRate": RATE,
        "channels": 2,
        "qualityApplied": output_format in {"mp3", "ogg"},
    }
    assert abs(details["durationSeconds"] - SECONDS) < 0.06


def test_mp3_support_is_real_round_trip() -> None:
    """Das Wheel muss MP3 tatsächlich lesen und schreiben (nicht nur melden)."""
    buffer = io.BytesIO()
    sf.write(buffer, sine(1), RATE, format="MP3", subtype="MPEG_LAYER_III")
    assert buffer.getvalue()[:3] == b"ID3" or buffer.getvalue()[0] == 0xFF
    buffer.seek(0)
    data, rate = sf.read(buffer, always_2d=True)
    assert rate == RATE and data.shape[1] == 1 and data.shape[0] > RATE * 0.25


def test_opus_input_is_decoded(tmp_path: Path, limits: Limits) -> None:
    sf.write(tmp_path / "input", sine(2, 48_000), 48_000, format="OGG", subtype="OPUS")
    details, target = run(tmp_path, limits, format="flac")
    assert sf.info(target).format == "FLAC"
    assert details["sampleRate"] == 48_000


def test_mono_downmix_is_mean(tmp_path: Path, limits: Limits) -> None:
    source = sine(2)
    sf.write(tmp_path / "input", source, RATE, format="WAV", subtype="FLOAT")
    details, target = run(tmp_path, limits, format="wav", channels="mono")
    data, _ = sf.read(target, always_2d=True, dtype="float64")
    assert data.shape[1] == 1 and details["channels"] == 1
    assert np.allclose(data[:, 0], source.mean(axis=1), atol=1e-6)


@pytest.mark.parametrize(
    ("source_subtype", "expected"),
    [
        ("PCM_16", "PCM_16"),
        ("PCM_U8", "PCM_16"),
        ("PCM_24", "PCM_24"),
        ("PCM_32", "PCM_32"),
        ("FLOAT", "FLOAT"),
        ("DOUBLE", "PCM_16"),
    ],
)
def test_wav_subtype_follows_source(
    tmp_path: Path, limits: Limits, source_subtype: str, expected: str
) -> None:
    sf.write(tmp_path / "input", sine(1), RATE, format="WAV", subtype=source_subtype)
    run(tmp_path, limits, format="wav")
    assert sf.info(tmp_path / "output").subtype == expected


def test_flac_keeps_24_bit(tmp_path: Path, limits: Limits) -> None:
    sf.write(tmp_path / "input", sine(1), RATE, format="WAV", subtype="PCM_24")
    run(tmp_path, limits, format="flac")
    assert sf.info(tmp_path / "output").subtype == "PCM_24"


def test_24_bit_samples_survive_losslessly(tmp_path: Path, limits: Limits) -> None:
    sf.write(tmp_path / "input", sine(2), RATE, format="FLAC", subtype="PCM_24")
    run(tmp_path, limits, format="wav")
    original, _ = sf.read(tmp_path / "input", dtype="int32")
    converted, _ = sf.read(tmp_path / "output", dtype="int32")
    assert np.array_equal(original, converted)


def test_clipping_instead_of_wraparound(tmp_path: Path, limits: Limits) -> None:
    loud = np.full((4410, 1), 1.5)
    loud[::2] = -1.5
    # DOUBLE-Quelle ergibt PCM_16; ohne Begrenzung liefe 1,5 über.
    sf.write(tmp_path / "input", loud, RATE, format="WAV", subtype="DOUBLE")
    run(tmp_path, limits, format="wav")
    data, _ = sf.read(tmp_path / "output", dtype="int16", always_2d=True)
    assert data[0, 0] == -32768 and data[1, 0] == 32767


@pytest.mark.parametrize("output_format", ["mp3", "ogg"])
def test_quality_changes_size(tmp_path: Path, limits: Limits, output_format: str) -> None:
    write_input(tmp_path / "input", "wav", seconds=2)
    sizes = []
    for quality in (0.0, 1.0):
        target = target_file(tmp_path / f"out-{quality}")
        convert(tmp_path / "input", target, options(format=output_format, quality=quality), limits)
        sizes.append(target.stat().st_size)
    assert sizes[0] < sizes[1]


# --- Grenzen und Fehler -------------------------------------------------------


def test_duration_limit_from_header(tmp_path: Path, limits: Limits) -> None:
    write_input(tmp_path / "input", "wav", channels=1, rate=8000, seconds=3)
    target = target_file(tmp_path / "output")
    with pytest.raises(ProcessingError) as exc:
        convert(
            tmp_path / "input", target, options(), replace(limits, audio_max_duration_seconds=2)
        )
    assert exc.value.code == "duration-too-long"
    assert target.stat().st_size == 0


def test_lying_header_is_caught_while_decoding(
    tmp_path: Path, limits: Limits, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_input(tmp_path / "input", "flac", channels=1, rate=8000, seconds=3)
    # Header behauptet 1 Frame; erst das blockweise Dekodieren zeigt die Wahrheit.
    monkeypatch.setattr(pipeline, "header_frames", lambda _reader: 1)
    monkeypatch.setattr(pipeline, "BLOCK_FRAMES", 4000)
    with pytest.raises(ProcessingError) as exc:
        convert(
            tmp_path / "input",
            target_file(tmp_path / "output"),
            options(),
            replace(limits, audio_max_duration_seconds=2),
        )
    assert exc.value.code == "duration-too-long"


@pytest.mark.parametrize(
    ("prepare", "limit"),
    [
        (lambda p: write_input(p, "wav", channels=3), {"audio_max_channels": 2}),
        (lambda p: write_input(p, "wav", rate=48_000), {"audio_max_sample_rate": 44_100}),
    ],
)
def test_channel_and_rate_limits(tmp_path: Path, limits: Limits, prepare: Any, limit: Any) -> None:
    prepare(tmp_path / "input")
    with pytest.raises(ProcessingError) as exc:
        run(tmp_path, replace(limits, **limit))
    assert exc.value.code == "unsupported-audio"


@pytest.mark.parametrize(
    ("channels", "rate"),
    [(3, RATE), (2, 96_000)],
    ids=["too-many-channels", "unsupported-rate"],
)
def test_mp3_target_constraints(tmp_path: Path, limits: Limits, channels: int, rate: int) -> None:
    write_input(tmp_path / "input", "wav", channels=channels, rate=rate)
    with pytest.raises(ProcessingError) as exc:
        run(tmp_path, limits, format="mp3")
    assert exc.value.code == "unsupported-audio"
    # Mit Downmix passen drei Kanäle in MP3.
    if channels == 3:
        target = target_file(tmp_path / "mono")
        details = convert(
            tmp_path / "input", target, options(format="mp3", channels="mono"), limits
        )
        assert details["channels"] == 1 and sf.info(target).channels == 1


def test_input_size_limit(tmp_path: Path, limits: Limits) -> None:
    write_input(tmp_path / "input", "wav")
    with pytest.raises(ProcessingError) as exc:
        run(tmp_path, replace(limits, audio_max_input_bytes=100))
    assert exc.value.code == "file-too-large"


@pytest.mark.parametrize("output_format", ["wav", "flac", "mp3", "ogg"])
def test_output_limit(tmp_path: Path, limits: Limits, output_format: str) -> None:
    write_input(tmp_path / "input", "wav")
    target = target_file(tmp_path / "output")
    with pytest.raises(ProcessingError) as exc:
        convert(
            tmp_path / "input",
            target,
            options(format=output_format),
            replace(limits, audio_max_output_bytes=500),
        )
    assert exc.value.code == "result-too-large"
    assert target.stat().st_size <= 500


@pytest.mark.parametrize(
    ("data", "code"),
    [
        (b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00" + b"\x00" * 30, "decode-failed"),
        (b"fLaC" + b"\x00" * 60, "decode-failed"),
        (b"OggS" + b"\x00" * 60, "decode-failed"),
        (b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\x00" * 200, "decode-failed"),
        (b"\xff\xfb\x90\x00" + b"\x00" * 10, "decode-failed"),
        (b"%PDF-1.7\n" + b"\x00" * 100, "decode-failed"),
    ],
    ids=["wav-header", "flac-header", "ogg-page", "id3-only", "mp3-frame", "pdf"],
)
def test_broken_and_fake_headers(tmp_path: Path, limits: Limits, data: bytes, code: str) -> None:
    (tmp_path / "input").write_bytes(data)
    target = target_file(tmp_path / "output")
    with pytest.raises(ProcessingError) as exc:
        convert(tmp_path / "input", target, options(), limits)
    assert exc.value.code in {code, "unsupported-type"}
    assert target.stat().st_size == 0


def test_truncated_flac_fails_or_is_shorter(tmp_path: Path, limits: Limits) -> None:
    write_input(tmp_path / "input", "flac", seconds=1)
    data = (tmp_path / "input").read_bytes()
    (tmp_path / "input").write_bytes(data[: len(data) // 2])
    try:
        details, _ = run(tmp_path, limits)
    except ProcessingError as exc:
        assert exc.code == "decode-failed"
    else:
        assert details["durationSeconds"] < 1


def test_other_libsndfile_formats_are_rejected(tmp_path: Path, limits: Limits) -> None:
    sf.write(tmp_path / "input", sine(1), RATE, format="AIFF", subtype="PCM_16")
    with pytest.raises(ProcessingError) as exc:
        run(tmp_path, limits)
    assert exc.value.code == "unsupported-type"


def test_empty_audio_is_rejected(tmp_path: Path, limits: Limits) -> None:
    sf.write(tmp_path / "input", np.zeros((0, 1)), RATE, format="WAV", subtype="PCM_16")
    with pytest.raises(ProcessingError) as exc:
        run(tmp_path, limits)
    assert exc.value.code == "decode-failed"
