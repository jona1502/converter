"""B01-PoC: aktuelle PyPI-Versionen, Lizenz und Python-3.13-Eignung abfragen.

Läuft auf dem Host (braucht Netzwerk). Ausgabe: Markdown-Tabelle auf stdout.
"""

from __future__ import annotations

import json
import sys
import urllib.request

PACKAGES = [
    "fastapi", "pydantic", "sqlalchemy", "alembic", "psycopg", "psycopg-binary",
    "celery", "redis", "kombu", "pillow", "pikepdf", "uvicorn", "python-multipart",
    "pytest", "ruff", "mypy", "pypdfium2",
]


def wheel_ok_313(files: list[dict]) -> str:
    """Prüft, ob für Linux x86_64 + CPython 3.13 ein Wheel existiert."""
    names = [f["filename"] for f in files if f["filename"].endswith(".whl")]
    if any("py3-none-any" in n or "py2.py3-none-any" in n for n in names):
        return "reines Python-Wheel"
    linux = [n for n in names if "manylinux" in n and "x86_64" in n]
    if any("cp313-cp313-" in n for n in linux):
        return "cp313 manylinux x86_64"
    if any("abi3" in n for n in linux):
        return "abi3 manylinux x86_64"
    if any("py3-none-manylinux" in n for n in linux):
        return "py3-none manylinux x86_64"
    return "KEIN passendes Wheel"


def main() -> int:
    print("| Paket | Version | veröffentlicht | Lizenz (PyPI) | requires_python | Wheel für Linux/3.13 |")
    print("| --- | --- | --- | --- | --- | --- |")
    bad = 0
    for p in PACKAGES:
        with urllib.request.urlopen(f"https://pypi.org/pypi/{p}/json", timeout=30) as r:
            d = json.loads(r.read().decode("utf-8"))
        info = d["info"]
        ver = info["version"]
        files = d["releases"][ver]
        up = min((f["upload_time"] for f in files), default="?")[:10]
        lic = info.get("license_expression") or ""
        if not lic:
            lic = "; ".join(c.split(" :: ")[-1] for c in info["classifiers"] if c.startswith("License"))
        if not lic:
            lic = (info.get("license") or "?").splitlines()[0][:40]
        w = wheel_ok_313(files)
        bad += w.startswith("KEIN")
        print(f"| {p} | {ver} | {up} | {lic} | {info.get('requires_python')} | {w} |")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
