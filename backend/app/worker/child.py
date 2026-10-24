"""Privates JSONL-Protokoll; dieser Prozess kennt keine DB- oder Broker-Secrets."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from app.worker.sandbox import isolate


def emit(value: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main() -> None:
    request = json.loads(sys.stdin.read())
    isolate(request["memory"], request["timeout"], request["outputLimit"])
    # Erst nach Isolation native Parser importieren.
    from app.core.config import Settings
    from app.schemas.options import JOB_OPTIONS_ADAPTER, ImageOptions

    settings = Settings(**request["limits"], environment="test")
    options = JOB_OPTIONS_ADAPTER.validate_json(json.dumps(request["options"]))
    source = Path(request["source"])
    if isinstance(options, ImageOptions):
        from app.processing.images.pipeline import convert

        result = request["results"][0]
        emit({"kind": "progress", "phase": "encode"})
        try:
            details = convert(source, Path(result["path"]), options, settings)
            emit(
                {
                    "kind": "result",
                    "id": result["id"],
                    "details": details,
                    "size": Path(result["path"]).stat().st_size,
                }
            )
        except Exception as exc:
            emit(
                {"kind": "error", "id": result["id"], "code": getattr(exc, "code", "encode-failed")}
            )
    else:
        from app.processing.pdf.pipeline import analyze, compress

        analysis = analyze(source, settings)
        emit({"kind": "analysis", "analysis": analysis})
        total_bytes = 0
        for result in request["results"]:
            level = result["level"]

            def progress(current: int, total: int, level: str = level) -> None:
                emit(
                    {
                        "kind": "progress",
                        "phase": "variant",
                        "progress": {
                            "step": "variant",
                            "level": level,
                            "current": current,
                            "total": total,
                        },
                    }
                )

            try:
                details = compress(source, Path(result["path"]), level, settings, progress)
                size = Path(result["path"]).stat().st_size
                total_bytes += size
                if total_bytes > settings.pdf_max_results_total_bytes:
                    Path(result["path"]).unlink(missing_ok=True)
                    emit({"kind": "error", "id": result["id"], "code": "result-too-large"})
                else:
                    emit({"kind": "result", "id": result["id"], "details": details, "size": size})
            except Exception as exc:
                emit(
                    {
                        "kind": "error",
                        "id": result["id"],
                        "code": getattr(exc, "code", "parse-failed"),
                    }
                )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        emit({"kind": "fatal", "code": getattr(exc, "code", "worker-failed")})
        sys.exit(1)
