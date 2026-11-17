"""Audiokonvertierung (MP3/WAV/FLAC/OGG) mit soundfile; nur im isolierten Prozess.

Dekodiert und kodiert blockweise, damit auch 30 Minuten Mehrkanalaudio unter
dem RLIMIT_AS des Parserprozesses bleiben. Die Dauer wird zuerst aus dem
Header geprüft und während des Dekodierens erneut gezählt, weil Header
lügen können. Keine Metadaten/Tags werden übernommen, kein Resampling.
"""

from __future__ import annotations

import io
from collections.abc import Callable
from pathlib import Path
from typing import Any, BinaryIO, Final, cast

import numpy as np
import soundfile as sf

from converter.errors import ProcessingError
from converter.limits import Limits
from converter.options import AUDIO_QUALITY_FORMATS, AudioOptions
from converter.processing.files import open_result

INPUTS: Final = ("mp3", "wav", "flac", "ogg")
OUTPUTS: Final = ("mp3", "wav", "flac", "ogg")
# libsndfile-Container -> Vertragsformat. WAVEX = WAV mit Extensible-Header.
CONTAINERS: Final = {"MP3": "mp3", "WAV": "wav", "WAVEX": "wav", "FLAC": "flac", "OGG": "ogg"}
OGG_CODECS: Final = frozenset({"VORBIS", "OPUS"})
# LAME/MPEG-Abtastraten; ohne Resampling sind andere Raten nicht als MP3 darstellbar.
MP3_RATES: Final = frozenset({8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000})
MP3_MAX_CHANNELS: Final = 2
MP3_MAX_COMPRESSION: Final = 0.99
# Quellen mit mehr als 16 Bit behalten ihre Auflösung (WAV) bzw. 24 Bit (FLAC).
WAV_SUBTYPES: Final = {"PCM_24": "PCM_24", "PCM_32": "PCM_32", "FLOAT": "FLOAT"}
FLAC_HIGH_RES: Final = frozenset({"PCM_24", "PCM_32", "FLOAT", "DOUBLE"})
# Frames je Block: 65536 x 8 Kanäle x 8 Byte = 4 MiB.
BLOCK_FRAMES = 65_536


class _BoundedSink(io.RawIOBase):
    """Schreibziel für libsndfile (virtuelles I/O) mit harter Größengrenze.

    Ausnahmen in cffi-Callbacks gingen verloren; deshalb meldet ``write`` bei
    Überschreitung 0 geschriebene Bytes (libsndfile bricht ab) und merkt sich
    den Grund für ``result-too-large``.
    """

    def __init__(self, path: Path, limit: int) -> None:
        super().__init__()
        # Go legt diese Datei je Lease mit 0600 an; kein O_CREAT, kein Symlink.
        self._file = io.FileIO(open_result(path), "w")
        self.limit = limit
        self.exceeded = False

    def writable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def fileno(self) -> int:
        # Direkte fd-Schreibzugriffe würden die Grenze umgehen.
        raise io.UnsupportedOperation("bounded sink")

    def write(self, data: Any) -> int:
        size = len(memoryview(data))
        if self.exceeded or self._file.tell() + size > self.limit:
            self.exceeded = True
            return 0
        written = self._file.write(data)
        return written if written is not None else 0

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        return self._file.seek(offset, whence)

    def tell(self) -> int:
        return self._file.tell()

    def close(self) -> None:
        try:
            self._file.close()
        finally:
            super().close()


def header_frames(reader: sf.SoundFile) -> int:
    """Framezahl laut Header (separat, damit Tests einen lügenden Header simulieren)."""
    return int(reader.frames)


def target_format(output: str, source_subtype: str) -> tuple[str, str]:
    """soundfile-Container und -Subtyp des Ergebnisses."""
    if output == "mp3":
        return "MP3", "MPEG_LAYER_III"
    if output == "ogg":
        return "OGG", "VORBIS"
    if output == "flac":
        return "FLAC", "PCM_24" if source_subtype in FLAC_HIGH_RES else "PCM_16"
    return "WAV", WAV_SUBTYPES.get(source_subtype, "PCM_16")


def encoder_options(output: str, quality: float) -> dict[str, Any]:
    """quality 0..1 -> libsndfile compression_level 1..0 (nur MP3/OGG)."""
    if output not in AUDIO_QUALITY_FORMATS:
        return {}
    level = min(1.0, max(0.0, 1.0 - quality))
    options: dict[str, Any] = {"compression_level": level}
    if output == "mp3":
        # LAME lehnt die VBR-Stufe 10 (compression_level 1,0) ab.
        options["compression_level"] = min(level, MP3_MAX_COMPRESSION)
        options["bitrate_mode"] = "VARIABLE"
    return options


def _check_source(reader: sf.SoundFile, limits: Limits) -> tuple[int, int, int]:
    if CONTAINERS.get(reader.format) is None:
        raise ProcessingError("unsupported-type")
    if reader.format == "OGG" and reader.subtype not in OGG_CODECS:
        raise ProcessingError("unsupported-audio")
    rate, channels = int(reader.samplerate), int(reader.channels)
    if not 1 <= channels <= limits.audio_max_channels:
        raise ProcessingError("unsupported-audio")
    if not 1 <= rate <= limits.audio_max_sample_rate:
        raise ProcessingError("unsupported-audio")
    max_frames = limits.audio_max_duration_seconds * rate
    if header_frames(reader) > max_frames:
        raise ProcessingError("duration-too-long")
    return rate, channels, max_frames


def _encode(
    reader: sf.SoundFile,
    sink: _BoundedSink,
    options: AudioOptions,
    rate: int,
    channels: int,
    max_frames: int,
    progress: Callable[[int, int], None] | None = None,
    total_frames: int = 0,
) -> int:
    container, subtype = target_format(options.format, str(reader.subtype))
    out_channels = 1 if options.channels == "mono" else channels
    try:
        writer = sf.SoundFile(
            cast(BinaryIO, sink),  # virtuelles I/O: write/seek/tell genügen
            "w",
            samplerate=rate,
            channels=out_channels,
            subtype=subtype,
            format=container,
            **encoder_options(options.format, options.quality),
        )
    except (sf.LibsndfileError, RuntimeError, ValueError, TypeError) as exc:
        raise ProcessingError("encode-failed") from exc
    total = 0
    try:
        while True:
            try:
                block = reader.read(BLOCK_FRAMES, dtype="float64", always_2d=True)
            except (sf.LibsndfileError, RuntimeError, ValueError) as exc:
                raise ProcessingError("decode-failed") from exc
            if not len(block):
                break
            total += len(block)
            if progress is not None:
                # Der Header kann lügen: current nie über total melden.
                progress(total, max(total, total_frames))
            if total > max_frames:
                raise ProcessingError("duration-too-long")
            if out_channels != channels:
                block = block.mean(axis=1, keepdims=True)
            # Dekodierte MP3/Vorbis-Werte können ±1 überschreiten; libsndfile
            # würde sie bei PCM-Zielen sonst überlaufen lassen.
            np.clip(block, -1.0, 1.0, out=block)
            try:
                writer.write(block)
            # soundfile prüft kurze Schreibvorgänge per assert.
            except (sf.LibsndfileError, RuntimeError, ValueError, AssertionError) as exc:
                raise ProcessingError("encode-failed") from exc
    finally:
        try:
            writer.close()
        except (sf.LibsndfileError, RuntimeError, ValueError) as exc:
            # Nur melden, wenn nicht schon ein fachlicher Fehler unterwegs ist.
            if not sink.exceeded:
                raise ProcessingError("encode-failed") from exc
    return total


def _convert(
    source: Path,
    target: Path,
    options: AudioOptions,
    limits: Limits,
    progress: Callable[[int, int], None] | None,
) -> dict[str, Any]:
    if source.stat().st_size > limits.audio_max_input_bytes:
        raise ProcessingError("file-too-large")
    try:
        reader = sf.SoundFile(str(source))
    except (sf.LibsndfileError, RuntimeError, ValueError, TypeError) as exc:
        raise ProcessingError("decode-failed") from exc
    with reader:
        rate, channels, max_frames = _check_source(reader, limits)
        out_channels = 1 if options.channels == "mono" else channels
        if options.format == "mp3" and (rate not in MP3_RATES or out_channels > MP3_MAX_CHANNELS):
            raise ProcessingError("unsupported-audio")
        sink = _BoundedSink(target, limits.audio_max_output_bytes)
        try:
            total = _encode(
                reader, sink, options, rate, channels, max_frames, progress, header_frames(reader)
            )
        except ProcessingError:
            if sink.exceeded:
                raise ProcessingError("result-too-large") from None
            raise
        finally:
            sink.close()
        if sink.exceeded:
            raise ProcessingError("result-too-large")
    if total == 0:
        raise ProcessingError("decode-failed")
    return {
        "format": options.format,
        "durationSeconds": round(total / rate, 3),
        "sampleRate": rate,
        "channels": out_channels,
        "qualityApplied": options.format in AUDIO_QUALITY_FORMATS,
    }


def convert(
    source: Path,
    target: Path,
    options: AudioOptions,
    limits: Limits,
    progress: Callable[[int, int], None] | None = None,
) -> dict[str, Any]:
    """Konvertiert; ``progress(frames_decoded, frames_total)`` nach jedem Block."""
    try:
        return _convert(source, target, options, limits, progress)
    except ProcessingError:
        raise
    except MemoryError:
        raise
    except (sf.LibsndfileError, RuntimeError, ValueError, OSError, EOFError) as exc:
        raise ProcessingError("decode-failed") from exc
