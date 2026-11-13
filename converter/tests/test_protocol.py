"""Prozessprotokoll: Anfrageprüfung, Ereignisse und echte CLI-Läufe.

Unter Linux laufen die CLI-Fälle mit aktiver Sandbox (seccomp, RLIMITs).
"""

from __future__ import annotations

import io
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pikepdf
import pytest
from PIL import Image

from converter.errors import ProtocolError
from converter.limits import Limits
from converter.processing.pdf.pipeline import compress
from converter.protocol import (
    FATAL_CODES,
    MAX_EVENT_BYTES,
    MAX_REQUEST_BYTES,
    RESULT_CODES,
    EventWriter,
    encode_event,
    parse_request,
)
from tests.helpers import encode, fixture_pdf, new_id, request, run_cli, target_file

IMAGE_OPTIONS: dict[str, Any] = {"tool": "image-convert", "format": "webp"}
PDF_OPTIONS: dict[str, Any] = {"tool": "pdf-compress"}


def image_request(tmp_path: Path, **overrides: Any) -> tuple[dict[str, Any], str, Path]:
    source = tmp_path / "input"
    if not source.exists():
        Image.new("RGB", (40, 20), "red").save(source, format="PNG")
    result_id = new_id()
    target = target_file(tmp_path / f"result-{result_id}")
    options = overrides.pop("options", IMAGE_OPTIONS)
    return request(source, options, [(result_id, None, target)], **overrides), result_id, target


def pdf_request(
    tmp_path: Path, levels: tuple[str, ...] = ("high", "balanced", "small"), **overrides: Any
) -> tuple[dict[str, Any], list[tuple[str, str | None, Path]]]:
    source = tmp_path / "input.pdf"
    if not source.exists():
        fixture_pdf(source)
    results: list[tuple[str, str | None, Path]] = []
    for level in levels:
        result_id = new_id()
        results.append((result_id, level, target_file(tmp_path / f"{level}-{result_id}")))
    options = {"tool": "pdf-compress", "levels": list(levels)}
    return request(source, options, results, **overrides), results


# --- Anfrage (ohne Kindprozess) ----------------------------------------------------


def test_valid_request_is_parsed(tmp_path: Path) -> None:
    body, result_id, target = image_request(tmp_path)
    parsed = parse_request(encode(body))
    assert parsed.results[0].id == result_id
    assert parsed.results[0].path == str(target)
    assert parsed.limits.image_max_output_bytes == 104_857_600
    assert (parsed.memory, parsed.timeout, parsed.output_limit) == (1 << 30, 60, 300_000_000)


@pytest.mark.parametrize(
    ("mutate", "code"),
    [
        (lambda b: b.pop("protocolVersion"), "protocol-error"),
        (lambda b: b.update(protocolVersion=2), "protocol-error"),
        (lambda b: b.update(protocolVersion="1"), "protocol-error"),
        (lambda b: b.update(protocolVersion=1.0), "protocol-error"),
        (lambda b: b.update(extra=True), "protocol-error"),
        (lambda b: b.pop("outputLimit"), "protocol-error"),
        (lambda b: b.update(memory=0), "protocol-error"),
        (lambda b: b.update(timeout=True), "protocol-error"),
        (lambda b: b.update(timeout=3601), "protocol-error"),
        (lambda b: b.update(source="relative/input"), "protocol-error"),
        (lambda b: b.update(source=""), "protocol-error"),
        (lambda b: b["limits"].pop("imageMaxEdge"), "protocol-error"),
        (lambda b: b["limits"].update(image_max_edge=1), "protocol-error"),
        (lambda b: b["limits"].update(imageMaxEdge=-1), "protocol-error"),
        (lambda b: b["results"][0].update(id="not-a-uuid"), "protocol-error"),
        (lambda b: b["results"][0].update(id=b["results"][0]["id"].upper()), "protocol-error"),
        (lambda b: b["results"][0].update(level="high"), "protocol-error"),
        (lambda b: b["results"][0].update(size=1), "protocol-error"),
        (lambda b: b["results"][0].pop("level"), "protocol-error"),
        (lambda b: b["results"].append(dict(b["results"][0])), "protocol-error"),
        (lambda b: b.update(results=[]), "protocol-error"),
        (lambda b: b["results"][0].update(path=b["source"]), "protocol-error"),
        (lambda b: b["limits"].pop("audioMaxDurationSeconds"), "protocol-error"),
        (lambda b: b["limits"].update(audioMaxChannels=0), "protocol-error"),
        (lambda b: b["limits"].update(audioMaxSampleRate=1.5), "protocol-error"),
        (lambda b: b["options"].update(quality=2), "invalid-options"),
        (lambda b: b["options"].update(unknown=1), "invalid-options"),
    ],
)
def test_invalid_requests(tmp_path: Path, mutate: Any, code: str) -> None:
    body, _, _ = image_request(tmp_path)
    body = json.loads(json.dumps(body))
    mutate(body)
    with pytest.raises(ProtocolError) as exc:
        parse_request(encode(body))
    assert exc.value.code == code


def test_pdf_results_must_match_levels(tmp_path: Path) -> None:
    body, _ = pdf_request(tmp_path, ("high", "small"))
    parse_request(encode(body))
    body["results"].reverse()
    with pytest.raises(ProtocolError):
        parse_request(encode(body))
    body["results"].reverse()
    body["results"][1]["id"] = body["results"][0]["id"]
    with pytest.raises(ProtocolError):
        parse_request(encode(body))


@pytest.mark.parametrize(
    "raw",
    [
        b"",
        b"not json",
        b"[]",
        b'{"protocolVersion": 1} {}',
        b'{"protocolVersion": 1, "protocolVersion": 1}',
        b'{"protocolVersion": NaN}',
        b"\xff\xfe",
        b"[" * 100_000,
    ],
    ids=["empty", "text", "array", "trailing", "duplicate", "nan", "utf8", "deep"],
)
def test_malformed_json(raw: bytes) -> None:
    with pytest.raises(ProtocolError) as exc:
        parse_request(raw)
    assert exc.value.code == "protocol-error"


def test_events_are_compact_ascii_and_bounded() -> None:
    sink = io.BytesIO()
    writer = EventWriter(sink)
    writer.progress_encode()
    writer.result("id", {"format": "png", "name": "Bärbel"})
    writer.error("id", "decode-failed", "encode-failed")
    writer.error("id", "/secret/path", "encode-failed")
    writer.fatal("Traceback: /secret")
    lines = sink.getvalue().splitlines()
    assert lines[0] == b'{"kind":"progress","phase":"encode"}'
    assert b"\\u00e4" in lines[1]
    assert json.loads(lines[3])["code"] == "encode-failed"
    assert json.loads(lines[4]) == {"kind": "fatal", "code": "worker-failed"}
    with pytest.raises(ValueError, match="too large"):
        encode_event({"kind": "analysis", "analysis": {"x": "a" * MAX_EVENT_BYTES}})
    with pytest.raises(ValueError):
        encode_event({"kind": "result", "details": {"x": float("nan")}})
    assert RESULT_CODES < FATAL_CODES


# --- echte CLI-Läufe --------------------------------------------------------------


def assert_clean(stdout: bytes, tmp_path: Path) -> None:
    """Keine Pfade, Dateinamen oder Ausnahmetexte in Ereignissen."""
    escaped = json.dumps(str(tmp_path))[1:-1].encode()
    for line in stdout.splitlines():
        assert len(line) + 1 <= MAX_EVENT_BYTES
        assert str(tmp_path).encode() not in line and escaped not in line
        assert b"input" not in line and b"Traceback" not in line


def test_cli_image_job_completes(tmp_path: Path) -> None:
    body, result_id, target = image_request(tmp_path)
    result = run_cli(["run"], encode(body))
    assert result.returncode == 0, result.stderr
    assert result.events == [
        {"kind": "progress", "phase": "encode"},
        {
            "kind": "result",
            "id": result_id,
            "details": {
                "format": "webp",
                "width": 40,
                "height": 20,
                "sourceWidth": 40,
                "sourceHeight": 20,
                "upscaled": False,
                "transparencyFlattened": False,
                "qualityApplied": True,
            },
        },
    ]
    assert_clean(result.stdout, tmp_path)
    with Image.open(target) as image:
        image.load()
        assert image.format == "WEBP" and image.size == (40, 20)


@pytest.mark.parametrize(
    ("prepare", "code"),
    [
        (lambda p: p.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 40), "decode-failed"),
        (
            lambda p: Image.new("RGB", (4, 4)).save(
                p, format="GIF", save_all=True, append_images=[Image.new("RGB", (4, 4), "red")]
            ),
            "animated-unsupported",
        ),
        (lambda p: Image.new("RGB", (300, 300)).save(p, format="PNG"), "dimensions-too-large"),
        (lambda p: p.write_bytes(b"%PDF-1.7\n"), "decode-failed"),
    ],
)
def test_cli_image_error_codes(tmp_path: Path, prepare: Any, code: str) -> None:
    prepare(tmp_path / "input")
    body, result_id, target = image_request(tmp_path)
    body["limits"]["imageMaxPixels"] = 50_000
    result = run_cli(["run"], encode(body))
    assert result.returncode == 0
    assert result.events[-1] == {"kind": "error", "id": result_id, "code": code}
    assert target.stat().st_size == 0
    assert_clean(result.stdout, tmp_path)


def test_cli_image_output_limit(tmp_path: Path) -> None:
    body, result_id, target = image_request(tmp_path, options={**IMAGE_OPTIONS, "format": "png"})
    body["limits"]["imageMaxOutputBytes"] = 20
    result = run_cli(["run"], encode(body))
    assert result.events[-1] == {"kind": "error", "id": result_id, "code": "result-too-large"}
    assert target.stat().st_size == 0


def test_cli_original_format_unsupported(tmp_path: Path) -> None:
    Image.new("RGB", (4, 4)).save(tmp_path / "input", format="GIF")
    body, result_id, _ = image_request(tmp_path, options={**IMAGE_OPTIONS, "format": "original"})
    result = run_cli(["run"], encode(body))
    assert result.events[-1] == {
        "kind": "error",
        "id": result_id,
        "code": "original-format-unsupported",
    }


def test_cli_missing_target_is_result_error(tmp_path: Path) -> None:
    body, result_id, target = image_request(tmp_path)
    target.unlink()
    result = run_cli(["run"], encode(body))
    assert result.events[-1] == {"kind": "error", "id": result_id, "code": "encode-failed"}
    assert not target.exists()


def test_cli_pdf_three_variants(tmp_path: Path) -> None:
    body, results = pdf_request(tmp_path)
    result = run_cli(["run"], encode(body))
    assert result.returncode == 0, result.stderr
    events = result.events
    assert events[0]["kind"] == "analysis"
    assert events[0]["analysis"]["pageCount"] == 1
    assert [e["id"] for e in events if e["kind"] == "result"] == [r[0] for r in results]
    progress = [e["progress"] for e in events if e["kind"] == "progress"]
    assert {p["level"] for p in progress} == {"high", "balanced", "small"}
    assert all(e.get("phase") == "variant" for e in events if e["kind"] == "progress")
    assert {"step": "variant", "level": "small", "current": 1, "total": 1} in progress
    for event in events:
        assert set(event) <= {"kind", "id", "details", "analysis", "phase", "progress", "code"}
        assert "size" not in event
    for _, _, path in results:
        with pikepdf.Pdf.open(path, attempt_recovery=False) as pdf:
            assert len(pdf.pages) == 1
            assert pdf.Root.AcroForm.Fields[0].V == "Alice"
            assert len(pdf.pages[0].Annots) == 1
    assert_clean(result.stdout, tmp_path)


def test_cli_pdf_partial_failure_keeps_earlier_levels(tmp_path: Path) -> None:
    body, results = pdf_request(tmp_path)
    results[1][2].unlink()  # „balanced“ ohne von Go angelegte Datei
    result = run_cli(["run"], encode(body))
    assert result.returncode == 0
    outcome = {e["id"]: e["kind"] for e in result.events if "id" in e}
    assert outcome == {results[0][0]: "result", results[1][0]: "error", results[2][0]: "result"}
    error = next(e for e in result.events if e["kind"] == "error")
    assert error["code"] == "save-failed"
    with pikepdf.Pdf.open(results[0][2], attempt_recovery=False) as pdf:
        assert len(pdf.pages) == 1


def test_cli_pdf_total_budget(tmp_path: Path) -> None:
    body, results = pdf_request(tmp_path)
    # Größe der ersten Stufe direkt messen, dann Budget knapp darüber setzen.
    probe = target_file(tmp_path / "measure.pdf")
    compress(tmp_path / "input.pdf", probe, "high", Limits(), lambda *_: None)
    budget = probe.stat().st_size + 10
    body["limits"]["pdfMaxResultsTotalBytes"] = budget
    body["outputLimit"] = budget
    result = run_cli(["run"], encode(body))
    assert result.returncode == 0, result.stderr
    kinds = [(e["kind"], e.get("code")) for e in result.events if "id" in e]
    assert kinds == [("result", None), ("error", "result-too-large"), ("error", "result-too-large")]
    high, balanced, small = (path for _, _, path in results)
    assert 0 < high.stat().st_size <= budget  # frühere Stufe bleibt vollständig
    assert balanced.stat().st_size == 0 and small.stat().st_size == 0
    with pikepdf.Pdf.open(high, attempt_recovery=False) as pdf:
        assert len(pdf.pages) == 1


def test_cli_pdf_analysis_failure_is_fatal(tmp_path: Path) -> None:
    source = tmp_path / "input.pdf"
    with pikepdf.Pdf.new() as pdf:
        pdf.add_blank_page()
        pdf.save(source, encryption=pikepdf.Encryption(owner="owner", user=""))
    body, _ = pdf_request(tmp_path, ("high",))
    result = run_cli(["run"], encode(body))
    assert result.returncode == 1
    assert result.events == [{"kind": "fatal", "code": "encrypted"}]


@pytest.mark.parametrize(
    "stdin",
    [
        b"",
        b"{",
        b'{"protocolVersion": 1}',
        b"x" * (MAX_REQUEST_BYTES + 1),
        b" " * MAX_REQUEST_BYTES + b"{}",
    ],
    ids=["empty", "truncated", "incomplete", "oversized", "oversized-valid"],
)
def test_cli_rejects_invalid_requests(stdin: bytes) -> None:
    result = run_cli(["run"], stdin)
    assert result.returncode == 1
    assert result.events == [{"kind": "fatal", "code": "protocol-error"}]


def test_cli_rejects_wrong_version_and_unknown_fields(tmp_path: Path) -> None:
    body, _, _ = image_request(tmp_path)
    mutations: list[Callable[[dict[str, Any]], None]] = [
        lambda b: b.update(protocolVersion=2),
        lambda b: b.update(unknown=1),
        lambda b: b["results"][0].update(size=5),
    ]
    for mutate in mutations:
        changed = json.loads(json.dumps(body))
        mutate(changed)
        result = run_cli(["run"], encode(changed))
        assert result.returncode == 1
        assert result.events == [{"kind": "fatal", "code": "protocol-error"}]
    changed = json.loads(json.dumps(body))
    changed["options"]["quality"] = "high"
    result = run_cli(["run"], encode(changed))
    assert result.events == [{"kind": "fatal", "code": "invalid-options"}]


def test_cli_usage() -> None:
    result = run_cli(["serve"])
    assert result.returncode == 2
    assert result.stdout == b""
