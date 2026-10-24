"""Schreibt das OpenAPI-Schema deterministisch nach ``api/openapi.json`` (kanonischer Vertrag).

Aufruf (im Verzeichnis ``backend``)::

    uv run python scripts/export_openapi.py          # schreiben
    uv run python scripts/export_openapi.py --check  # nur Drift prüfen

Das Schema hängt nicht von der Umgebung ab; die Settings hier sind feste
Platzhalter, damit das Ergebnis auf jedem Rechner identisch ist.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.core.config import Settings  # noqa: E402 – erst nach sys.path-Anpassung
from app.factory import create_app  # noqa: E402

OPENAPI_PATH = BACKEND_DIR.parent / "api" / "openapi.json"


def render_openapi() -> str:
    settings = Settings(environment="development", storage_dir=BACKEND_DIR / "unused")
    schema = create_app(settings).openapi()
    return json.dumps(schema, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("--check", action="store_true", help="nur prüfen, nicht schreiben")
    args = parser.parse_args(argv)

    rendered = render_openapi()
    if args.check:
        current = OPENAPI_PATH.read_text(encoding="utf-8") if OPENAPI_PATH.exists() else ""
        if current != rendered:
            print("openapi.json ist veraltet: scripts/export_openapi.py ausführen.")
            return 1
        print("openapi.json ist aktuell.")
        return 0
    OPENAPI_PATH.write_text(rendered, encoding="utf-8", newline="\n")
    print(f"geschrieben: {OPENAPI_PATH.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
