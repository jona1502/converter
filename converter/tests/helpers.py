"""Testhilfen: Dateien wie der Go-Worker anlegen, CLI als Kindprozess starten."""

from __future__ import annotations

import json
import os
import random
import subprocess
import sys
import uuid
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pikepdf
from pikepdf import Array, Dictionary, Name, Pdf, String
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
LINUX = sys.platform == "linux"
DEFAULT_LIMITS: dict[str, int] = {
    "imageMaxInputBytes": 52_428_800,
    "imageMaxPixels": 40_000_000,
    "imageMaxEdge": 16_384,
    "imageMaxOutputBytes": 104_857_600,
    "pdfMaxInputBytes": 100_000_000,
    "pdfMaxResultsTotalBytes": 300_000_000,
    "pdfImageMaxPixels": 40_000_000,
    "audioMaxInputBytes": 104_857_600,
    "audioMaxDurationSeconds": 1800,
    "audioMaxChannels": 8,
    "audioMaxSampleRate": 192_000,
    "audioMaxOutputBytes": 419_430_400,
}


def target_file(path: Path) -> Path:
    """Legt wie der Go-Worker eine leere private Ergebnisdatei exklusiv an."""
    path.touch(mode=0o600, exist_ok=False)
    return path


def child_env() -> dict[str, str]:
    """Kleine Allowlist wie im Go-Worker (Windows braucht SYSTEMROOT)."""
    keep = {"PATH", "LANG", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"}
    return {key: value for key, value in os.environ.items() if key in keep}


@dataclass
class CliResult:
    returncode: int
    stdout: bytes
    stderr: bytes

    @property
    def events(self) -> list[dict[str, Any]]:
        lines = self.stdout.decode("ascii").splitlines()
        return [json.loads(line) for line in lines]


def run_cli(args: list[str], stdin: bytes = b"", timeout: float = 120) -> CliResult:
    completed = subprocess.run(
        [sys.executable, "-m", "converter.cli", *args],
        input=stdin,
        capture_output=True,
        cwd=ROOT,
        env=child_env(),
        timeout=timeout,
        check=False,
    )
    return CliResult(completed.returncode, completed.stdout, completed.stderr)


def new_id() -> str:
    return str(uuid.uuid4())


def request(
    source: Path,
    options: dict[str, Any],
    results: list[tuple[str, str | None, Path]],
    **overrides: Any,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "protocolVersion": 1,
        "source": str(source),
        "options": options,
        "results": [{"id": i, "level": level, "path": str(path)} for i, level, path in results],
        "limits": dict(DEFAULT_LIMITS),
        "memory": 1 << 30,
        "timeout": 60,
        "outputLimit": 300_000_000,
    }
    body.update(overrides)
    return body


def encode(body: dict[str, Any]) -> bytes:
    return json.dumps(body).encode()


def fixture_pdf(path: Path, mask: bool = False) -> None:
    """Echte PDF mit geteiltem Bild, Form-XObject, Text, Link, Formular, Outline."""
    with Pdf.new() as pdf:
        page = pdf.add_blank_page(page_size=(612, 792))
        noise = random.Random(12).randbytes(600 * 400 * 3)  # noqa: S311 - fixture noise
        image = Image.frombytes("RGB", (600, 400), noise)
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
