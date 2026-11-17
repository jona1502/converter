"""Markdown contract and independent PDF text/layout checks."""

from __future__ import annotations

import io
import json
from dataclasses import replace
from pathlib import Path

import pikepdf
import pypdfium2 as pdfium  # type: ignore[import-untyped]
import pytest

from converter.errors import ProcessingError, ProtocolError
from converter.limits import Limits, parse_limits
from converter.options import parse_options
from converter.protocol import EventWriter, parse_request
from tests.helpers import DEFAULT_LIMITS, encode, new_id, request, run_cli, target_file


def render(
    tmp_path: Path, text: str | bytes, limits: Limits | None = None
) -> tuple[Path, dict[str, object]]:
    from converter.processing.markdown.pipeline import convert

    source = tmp_path / "source.md"
    source.write_bytes(text.encode("utf-8") if isinstance(text, str) else text)
    destination = tmp_path / "result.pdf"
    if not destination.exists():
        target_file(destination)
    details = convert(source, destination, limits or Limits())
    return destination, details


def texts(path: Path) -> list[str]:
    with pdfium.PdfDocument(path) as pdf:
        return [page.get_textpage().get_text_range() for page in pdf]


def test_markdown_options_and_legacy_limits() -> None:
    assert parse_options({"tool": "markdown-pdf"}).tool == "markdown-pdf"
    with pytest.raises(ProtocolError):
        parse_options({"tool": "markdown-pdf", "levels": []})
    limits = parse_limits(DEFAULT_LIMITS)
    assert limits.markdown_max_input_bytes == 2_097_152
    assert limits.markdown_max_output_bytes == 20_971_520
    assert limits.markdown_max_pages == 300
    assert parse_limits({**DEFAULT_LIMITS, "markdownMaxPages": 2}).markdown_max_pages == 2
    with pytest.raises(ProtocolError):
        parse_limits({**DEFAULT_LIMITS, "markdownMaxPages": True})
    with pytest.raises(ProtocolError):
        parse_limits({k: v for k, v in DEFAULT_LIMITS.items() if k != "imageMaxEdge"})


def test_syntax_selectable_umlauts_and_embedded_fonts(tmp_path: Path) -> None:
    path, details = render(
        tmp_path,
        """# Überschrift ÄÖÜ äöü ß

Text mit **Fett** und *Kursiv*, `inline` und [Link](https://example.org).

- Erster Punkt
- Zweiter Punkt

1. Geordnet
2. Weiter

> Ein Zitat

| Kopf | Wert |
| --- | --- |
| Zeile | Inhalt |

```python
print('Grüße')
```
""",
    )
    text = "\n".join(texts(path))
    for expected in [
        "Überschrift ÄÖÜ äöü ß",
        "Fett",
        "Kursiv",
        "Erster Punkt",
        "Geordnet",
        "Ein Zitat",
        "Kopf",
        "Inhalt",
        "print('Grüße')",
    ]:
        assert expected in text
    assert details == {"pageCount": 1}
    with pikepdf.open(path) as pdf:
        assert tuple(float(v) for v in pdf.pages[0].MediaBox)[2:] == pytest.approx(
            (595.276, 841.89), abs=0.01
        )
        fonts = pdf.pages[0].Resources.Font.values()
        assert any(
            "/FontDescriptor" in font and "/FontFile2" in font.FontDescriptor for font in fonts
        )


def test_long_code_and_table_cells_fit_and_preserve_text(tmp_path: Path) -> None:
    code = "W" * 12000 + "CODEEND"
    cell = "M" * 14000 + "CELLEND"
    path, details = render(
        tmp_path, f"```\n{code}\n```\n\n| Header | Value |\n| --- | --- |\n| {cell} | Last |\n"
    )
    pages = texts(path)
    joined = "".join(pages).replace("\r", "").replace("\n", "").replace(" ", "")
    assert code in joined
    assert cell in joined.replace("HeaderValue", "").replace("Last", "")
    assert details["pageCount"] == len(pages)
    assert len(pages) > 2
    assert sum("Header" in page for page in pages) > 1
    with pdfium.PdfDocument(path) as pdf:
        for page in pdf:
            text = page.get_textpage()
            width, height = page.get_size()
            for i in range(text.count_chars()):
                left, bottom, right, top = text.get_charbox(i)
                assert -1 <= left <= right <= width + 1
                assert -1 <= bottom <= top <= height + 1


@pytest.mark.parametrize(
    "payload",
    [b"", b" \t\r\n", b"\xef\xbb\xbf \n", b"\xff", b"abc\x00def", b"abc\x01def", b"abc\x7fdef"],
)
def test_rejects_empty_binary_and_invalid_utf8(tmp_path: Path, payload: bytes) -> None:
    with pytest.raises(ProcessingError) as exc:
        render(tmp_path, payload)
    assert exc.value.code == "decode-failed"


def test_bom_and_uncovered_unicode_do_not_crash(tmp_path: Path) -> None:
    path, _ = render(tmp_path, b"\xef\xbb\xbf" + "Grüße 😀 中文".encode())
    assert "Grüße" in texts(path)[0]


def test_boundaries_and_discard_partial_output(tmp_path: Path) -> None:
    render(tmp_path, "Hallo", replace(Limits(), markdown_max_input_bytes=5))
    for text, limits, code in [
        ("Hallo!", replace(Limits(), markdown_max_input_bytes=5), "file-too-large"),
        ("Hallo", replace(Limits(), markdown_max_output_bytes=100), "result-too-large"),
        ("Text\n\n" * 250, replace(Limits(), markdown_max_pages=1), "dimensions-too-large"),
    ]:
        with pytest.raises(ProcessingError) as exc:
            render(tmp_path, text, limits)
        assert exc.value.code == code
        assert (tmp_path / "result.pdf").stat().st_size == 0


def test_resources_are_literal_and_only_safe_links_active(tmp_path: Path) -> None:
    secret = tmp_path / "secret.txt"
    secret.write_text("SECRET_MUST_NOT_APPEAR")
    path, _ = render(
        tmp_path,
        f"""![Alt local]({secret.as_uri()})
![Alt external](https://127.0.0.1:1/image.png)
![Alt data](data:image/png;base64,AAAA)
<img src="{secret.as_uri()}" onerror="alert(1)">
<script>literal script</script>

[https](https://example.org) [http](http://example.org) [mail](mailto:a@example.org)
[file]({secret.as_uri()}) [relative](../secret.txt) [bad](javascript:alert%281%29)
""",
    )
    text = "\n".join(texts(path))
    assert "SECRET_MUST_NOT_APPEAR" not in text
    assert "Alt local" in text and "Alt external" in text and "Alt data" in text
    assert "<img" in text and "literal script" in " ".join(text.split())
    with pikepdf.open(path) as pdf:
        uris = [str(a.A.URI) for page in pdf.pages for a in page.get("/Annots", [])]
    assert sorted(uris) == ["http://example.org", "https://example.org", "mailto:a@example.org"]


def test_process_integration_and_target_contract(tmp_path: Path) -> None:
    from converter.execute import execute

    source = tmp_path / "input.md"
    source.write_text("# Grüße", encoding="utf-8")
    target = target_file(tmp_path / "out.pdf")
    result_id = new_id()
    body = request(source, {"tool": "markdown-pdf"}, [(result_id, None, target)])
    parsed = parse_request(encode(body))
    output = io.BytesIO()
    execute(parsed, EventWriter(output))
    assert [json.loads(line) for line in output.getvalue().splitlines()] == [
        {"kind": "progress", "phase": "encode"},
        {"kind": "result", "id": result_id, "details": {"pageCount": 1}},
    ]
    body["results"][0]["level"] = "high"
    with pytest.raises(ProtocolError):
        parse_request(encode(body))
    body["results"] = []
    with pytest.raises(ProtocolError):
        parse_request(encode(body))


def test_sandboxed_cli_and_capability_probe(tmp_path: Path) -> None:
    source = tmp_path / "input.md"
    source.write_text("# Grüße", encoding="utf-8")
    target = target_file(tmp_path / "output.pdf")
    result_id = new_id()
    result = run_cli(
        ["run"], encode(request(source, {"tool": "markdown-pdf"}, [(result_id, None, target)]))
    )
    assert result.returncode == 0, result.stderr
    assert result.events[-1] == {"kind": "result", "id": result_id, "details": {"pageCount": 1}}
    probe = run_cli(["probe"])
    assert json.loads(probe.stdout)["markdown"] == {"available": True}


def test_table_header_repeats_once_per_page(tmp_path: Path) -> None:
    source = "| Header | Description |\n| --- | --- |\n" + "".join(
        f"| {i} | A description that wraps over multiple lines in this cell. |\n" for i in range(80)
    )
    path, _ = render(tmp_path, source)
    pages = texts(path)
    assert len(pages) > 1
    assert all(page.count("Header") == 1 for page in pages)
    assert (
        " ".join(" ".join(pages).split()).count(
            "A description that wraps over multiple lines in this cell."
        )
        == 80
    )
    with pdfium.PdfDocument(path) as pdf:
        for page in pdf:
            text = page.get_textpage()
            for i in range(text.count_chars()):
                left, bottom, right, top = text.get_charbox(i)
                assert 42 <= left <= right <= 595.276 - 42
                assert 42 <= bottom <= top <= 841.89 - 42


@pytest.mark.parametrize(
    ("has_source", "allocate", "code"),
    [
        (False, True, "decode-failed"),
        (True, False, "encode-failed"),
    ],
)
def test_file_access_uses_stable_errors(
    tmp_path: Path, has_source: bool, allocate: bool, code: str
) -> None:
    from converter.processing.markdown.pipeline import convert

    source = tmp_path / "source.md"
    destination = tmp_path / "result.pdf"
    if has_source:
        source.write_text("Text", encoding="utf-8")
    if allocate:
        target_file(destination)
    with pytest.raises(ProcessingError) as exc:
        convert(source, destination, Limits())
    assert exc.value.code == code
    assert destination.exists() == allocate
