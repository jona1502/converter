"""Erzeugt options_golden.json für validation/options_test.go aus dem echten
Python-Backend (app.api.jobs.parse_options + app.schemas.options).

Liest nur und schreibt JSON nach stdout. Aufruf aus dem Repo-Root:

    cd backend && uv run python ../server/internal/validation/testdata/gen_options_golden.py \
        > ../server/internal/validation/testdata/options_golden.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[4] / "backend"))

from app.api.errors import ApiError  # noqa: E402
from app.api.jobs import parse_options  # noqa: E402
from app.schemas.options import canonical_json, canonical_options  # noqa: E402

CASES = [
    # gültig
    '{"tool":"image-convert","format":"webp"}',
    '{"tool":"image-convert","format":"jpeg","quality":0}',
    '{"tool":"image-convert","format":"jpeg","quality":1}',
    '{"tool":"image-compress","format":"jpeg","quality":0.5}',
    '{"tool":"image-compress","format":"webp","quality":0.123456789012345678}',
    '{"tool":"image-compress","format":"webp","quality":1e-7}',
    '{"tool":"image-convert","format":"png","background":"#ABCdef"}',
    '{"tool":"image-convert","format":"ico","icoSizes":[256,16]}',
    '{"tool":"image-convert","format":"original","icoSizes":[32]}',
    '{"tool":"image-convert","format":"ico","icoSizes":null}',
    '{"tool":"image-resize","format":"png","resize":{"mode":"none"}}',
    '{"tool":"image-resize","format":"png","resize":{"mode":"percent","percent":50,"allowUpscale":false}}',
    '{"tool":"image-resize","format":"png","resize":{"mode":"percent","percent":150.5,"allowUpscale":true}}',
    '{"tool":"image-resize","format":"png","resize":{"mode":"dimensions","width":100,"keepAspectRatio":true,"allowUpscale":false}}',
    '{"tool":"image-resize","format":"png","resize":{"mode":"dimensions","width":null,"height":20,"keepAspectRatio":true,"allowUpscale":false}}',
    '{"tool":"image-resize","format":"png","resize":{"mode":"dimensions","width":10,"height":20,"keepAspectRatio":false,"allowUpscale":true}}',
    '{"tool":"image-resize","format":"bmp","resize":{"mode":"maxEdge","maxEdge":2147483647}}',
    '{"resize":{"mode":"none"},"format":"webp","tool":"image-resize"}',
    '{"tool":"pdf-compress"}',
    '{"tool":"pdf-compress","levels":["small","high"]}',
    '{"tool":"image-convert","format":"png","quality":1.0}',
    # ungültig
    '{"tool":"image-convert","format":"jpeg","quality":1.5}',
    '{"tool":"image-convert","format":"jpeg","quality":-0.1}',
    '{"tool":"image-convert","format":"jpeg","quality":"0.5"}',
    '{"tool":"image-convert","format":"jpeg","quality":null}',
    '{"tool":"image-convert","format":"jpeg","quality":true}',
    '{"tool":"image-convert","format":"png","background":"red"}',
    '{"tool":"image-convert","format":"png","background":"#fff"}',
    '{"tool":"image-convert","format":"gif"}',
    '{"tool":"image-convert"}',
    '{"format":"png"}',
    '{"tool":"video","format":"png"}',
    '{"tool":"image-convert","format":"png","extra":1}',
    '{"tool":"image-convert","format":"png","Quality":0.5}',
    '{"tool":"image-convert","format":"png","icoSizes":[16]}',
    '{"tool":"image-convert","format":"ico","icoSizes":[]}',
    '{"tool":"image-convert","format":"ico","icoSizes":[16,16]}',
    '{"tool":"image-convert","format":"ico","icoSizes":[17]}',
    '{"tool":"image-convert","format":"ico","icoSizes":[16.0]}',
    '{"tool":"image-convert","format":"ico","resize":{"mode":"maxEdge","maxEdge":10}}',
    '{"tool":"image-resize","format":"png","resize":{"mode":"percent","percent":150,"allowUpscale":false}}',
    '{"tool":"image-resize","format":"png","resize":{"mode":"percent","percent":0,"allowUpscale":false}}',
    '{"tool":"image-resize","format":"png","resize":{"mode":"percent","percent":50}}',
    '{"tool":"image-resize","format":"png","resize":{"mode":"dimensions","keepAspectRatio":true,"allowUpscale":false}}',
    '{"tool":"image-resize","format":"png","resize":{"mode":"dimensions","width":10,"keepAspectRatio":false,"allowUpscale":false}}',
    '{"tool":"image-resize","format":"png","resize":{"mode":"dimensions","width":0,"height":5,"keepAspectRatio":false,"allowUpscale":false}}',
    '{"tool":"image-resize","format":"png","resize":{"mode":"dimensions","width":1.5,"height":5,"keepAspectRatio":false,"allowUpscale":false}}',
    '{"tool":"image-resize","format":"png","resize":{"mode":"maxEdge","maxEdge":2147483648}}',
    '{"tool":"image-resize","format":"png","resize":{"mode":"maxEdge"}}',
    '{"tool":"image-resize","format":"png","resize":{"mode":"zoom"}}',
    '{"tool":"image-resize","format":"png","resize":{}}',
    '{"tool":"image-resize","format":"png","resize":null}',
    '{"tool":"image-resize","format":"png","resize":{"mode":"none","width":3}}',
    '{"tool":"pdf-compress","levels":[]}',
    '{"tool":"pdf-compress","levels":["high","high"]}',
    '{"tool":"pdf-compress","levels":["huge"]}',
    '{"tool":"pdf-compress","levels":null}',
    '{"tool":"pdf-compress","format":"png"}',
    '{"tool":"image-convert","format":"png"} {}',
    '{"tool":',
    '[]',
    '"x"',
    '{"tool":"image-convert","format":"png","quality":1e400}',
    '{"tool":"image-convert","format":"jpeg","quality":2,"background":"x","extra":1}',
]


def main() -> None:
    out = []
    for raw in CASES:
        try:
            options = parse_options(raw.encode())
        except ApiError as exc:
            out.append(
                {
                    "input": raw,
                    "code": exc.code.value,
                    "fields": [f.model_dump() for f in exc.fields or []],
                }
            )
            continue
        out.append(
            {"input": raw, "canonical": canonical_json(canonical_options(options)).decode()}
        )
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
