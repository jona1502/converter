"""Erzeugt python_golden.json aus dem Python-Backend (Referenz für Go-Tests).

Aufruf im Verzeichnis backend:
    PYTHONPATH=. uv run python ../server/internal/jobs/testdata/gen_golden.py > ../server/internal/jobs/testdata/python_golden.json
"""

from __future__ import annotations

import hashlib
import json
import sys

from app.jobs.acceptance import fingerprint
from app.jobs.domain import InputFormat, OutputFormat, PdfLevel, Tool
from app.jobs.naming import (
    IMAGE_FALLBACK_BASE,
    PDF_FALLBACK_BASE,
    display_name,
    image_download_name,
    pdf_download_name,
)
from app.jobs.signatures import detect_image_format, is_pdf
from app.schemas.options import JOB_OPTIONS_ADAPTER, canonical_json, canonical_options

NAMES = [
    "", ".", "..", "...", "a", "photo.jpg", "Photo.JPEG", ".hidden", ".hidden.png", "a.b.c",
    "name.", "name..", "a..png", "  spaced   name .jpg", " . lead.png", "tab\tname.png",
    "new\nline.png", "nul\x00byte.png", "del\x7fchar.png", "c1\x85\x9fchars.png",
    "a/b\\c:d*e?f\"g<h>i|j.png", "../../etc/passwd", "C:\\Users\\x\\bild.png",
    "\u202ertl.png", "bidi\u200e\u200f\u061c\u2066\u2069.png", "x\u00a0y.png", "x\u2028y.png",
    "x\u2029y.png", "\u3000ideo\u3000.png", "x\u1680\u2000\u200a\u202f\u205fy.png", "x\u180ey.png",
    "x\u200by.png", "x\x1cy\x1fz.png", "ünïcödé.JPG", "日本語のファイル.png", "emoji😀🎉.png",
    "CON", "con.png", "CON.tar.gz", "Com1.jpg", "lpt9.pdf", "LPT0.pdf", "nul.", "aux .png",
    "auxiliary.png", "prn . png", "com10.png",
    "a" * 99 + ".png", "a" * 100 + ".png", "a" * 101 + ".png", "b" * 98 + " .x.png",
    "c" * 99 + "...png", "😀" * 120 + ".png", "x." + "e" * 20, "x.ex t", "x.\u202e", "x. ",
    "report.final.v2.PDF", "   .pdf", "-.pdf",
]

TOOL_FORMATS = [
    (Tool.IMAGE_CONVERT, InputFormat.PNG, OutputFormat.JPEG),
    (Tool.IMAGE_CONVERT, InputFormat.PNG, OutputFormat.PNG),
    (Tool.IMAGE_CONVERT, InputFormat.GIF, OutputFormat.ICO),
    (Tool.IMAGE_COMPRESS, InputFormat.JPEG, OutputFormat.JPEG),
    (Tool.IMAGE_RESIZE, InputFormat.WEBP, OutputFormat.WEBP),
    (Tool.IMAGE_RESIZE, InputFormat.BMP, OutputFormat.BMP),
]

OPTIONS = [
    '{"tool":"image-convert","format":"webp"}',
    '{"tool":"image-convert","format":"jpeg","quality":0}',
    '{"tool":"image-convert","format":"jpeg","quality":1}',
    '{"tool":"image-compress","format":"original","quality":0.5,"background":"#ABCDEF"}',
    '{"tool":"image-compress","format":"webp","quality":0.333333333333333314829616256247}',
    '{"tool":"image-convert","format":"ico","icoSizes":[256,16]}',
    '{"tool":"image-resize","format":"png","resize":{"mode":"percent","percent":50,"allowUpscale":false}}',
    '{"tool":"image-resize","format":"png","resize":{"mode":"percent","percent":0.00001,"allowUpscale":false}}',
    '{"tool":"image-resize","format":"png","resize":{"mode":"percent","percent":1e16,"allowUpscale":true}}',
    '{"tool":"image-resize","format":"png","resize":{"mode":"percent","percent":1234567890123456.7,"allowUpscale":true}}',
    '{"tool":"image-resize","format":"png","resize":{"mode":"percent","percent":0.0001,"allowUpscale":false}}',
    '{"tool":"image-resize","format":"bmp","resize":{"mode":"dimensions","width":800,"keepAspectRatio":true,"allowUpscale":false}}',
    '{"tool":"image-resize","format":"jpeg","resize":{"mode":"dimensions","width":1,"height":2,"keepAspectRatio":false,"allowUpscale":true}}',
    '{"tool":"image-resize","format":"original","resize":{"mode":"maxEdge","maxEdge":4096}}',
    '{"tool":"pdf-compress"}',
    '{"tool":"pdf-compress","levels":["small","high"]}',
]

SCALARS = [
    0.85, 1.0, 0.0, -0.0, 0.1, 1e-05, 0.0001, 1e15, 1e16, 9999999999999998.0, 123456789.125,
    5e-324, 1.7976931348623157e308, 2.5e-07, 100.0, 1e22, 1e21, 0.30000000000000004,
    "", "plain", "quote\"back\\slash/", "ctl\x00\x01\x08\x09\x0a\x0c\x0d\x1f\x7f",
    "uni ü 日本 😀", "html <a>&amp;</a>", "sep\u2028\u2029", "bidi\u202e",
    True, False, None, 0, -1, 2**53 + 1, [], {}, {"b": 1, "a": [1, 2.0, "x"], "ä": None, "Z": {}},
]

HEADS = [
    b"", b"\xff\xd8\xff\xe0", b"\xff\xd8", b"\x89PNG\r\n\x1a\n\x00", b"\x89PNG\r\n\x1a",
    b"RIFF\x00\x00\x00\x00WEBPVP8 ", b"RIFF\x00\x00\x00\x00WEBX", b"GIF87a", b"GIF89a....", b"GIF88a",
    b"BM" + b"\x00" * 12 + (40).to_bytes(4, "little"), b"BM" + b"\x00" * 12 + (41).to_bytes(4, "little"),
    b"BM" + b"\x00" * 10,
    b"\x00\x00\x01\x00\x01\x00" + b"\x10\x10\x00\x00\x01\x00\x20\x00" + (100).to_bytes(4, "little") + (22).to_bytes(4, "little"),
    b"\x00\x00\x01\x00\x01\x00" + b"\x10\x10\x00\x00\x01\x00\x20\x00" + (0).to_bytes(4, "little") + (22).to_bytes(4, "little"),
    b"\x00\x00\x01\x00\x01\x00" + b"\x10\x10\x00\x00\x01\x00\x20\x00" + (100).to_bytes(4, "little") + (21).to_bytes(4, "little"),
    b"\x00\x00\x01\x00\x01\x00", b"\x00\x00\x01\x00\x00\x00", b"\x00\x00\x02\x00\x01\x00",
    (24).to_bytes(4, "big") + b"ftypavif\x00\x00\x00\x00mif1miaf",
    (24).to_bytes(4, "big") + b"ftypmif1\x00\x00\x00\x00miafavis",
    (24).to_bytes(4, "big") + b"ftypheic\x00\x00\x00\x00mif1heic",
    (8).to_bytes(4, "big") + b"ftypavif\x00\x00\x00\x00",
    (5000).to_bytes(4, "big") + b"ftypavif\x00\x00\x00\x00",
    (20).to_bytes(4, "big") + b"ftypmif1\x00\x00\x00\x00avi",
    (32).to_bytes(4, "big") + b"ftypmif1\x00\x00\x00\x00miafavif",
    b"%PDF-1.7\n", b"garbage" * 10 + b"%PDF-1.4", b"x" * 1019 + b"%PDF-", b"x" * 1020 + b"%PDF-",
    b"%PDF", b"hello world",
]


def main() -> None:
    names = []
    for name in NAMES:
        entry = {
            "name": name,
            "displayImage": display_name(name, IMAGE_FALLBACK_BASE),
            "displayPdf": display_name(name, PDF_FALLBACK_BASE),
            "pdf": {level.value: pdf_download_name(name, level) for level in PdfLevel},
            "image": [
                {"tool": t.value, "input": i.value, "output": o.value,
                 "name": image_download_name(name, t, i, o)}
                for t, i, o in TOOL_FORMATS
            ],
        }
        names.append(entry)

    sha = hashlib.sha256(b"file").digest()
    options = []
    for raw in OPTIONS:
        parsed = JOB_OPTIONS_ADAPTER.validate_json(raw)
        options.append({
            "input": raw,
            "canonical": canonical_json(canonical_options(parsed)).decode(),
            "fileSha256": sha.hex(),
            "fileSize": 12345,
            "fingerprint": fingerprint(parsed, sha, 12345).hex(),
        })

    scalars = [{"value": v, "canonical": canonical_json(v).decode()} for v in SCALARS]
    heads = [
        {"head": h.hex(), "image": (detect_image_format(h) or None) and detect_image_format(h).value,
         "pdf": is_pdf(h)}
        for h in HEADS
    ]
    json.dump({"names": names, "options": options, "scalars": scalars, "heads": heads},
              sys.stdout, ensure_ascii=True, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
