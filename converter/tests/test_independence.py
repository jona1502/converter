"""Der Konverter hängt nicht vom FastAPI-Backend ab und lädt Parser erst isoliert."""

from __future__ import annotations

import ast
import json
import subprocess
import sys
from pathlib import Path

from tests.helpers import ROOT, child_env

PACKAGE = ROOT / "converter"
FORBIDDEN = {
    "app",
    "backend",
    "fastapi",
    "starlette",
    "sqlalchemy",
    "alembic",
    "psycopg",
    "celery",
    "kombu",
    "redis",
    "pydantic",
    "pydantic_core",
    "pydantic_settings",
    "uvicorn",
}
NATIVE = {"PIL", "pikepdf"}
PRE_SANDBOX = [
    "converter",
    "converter.cli",
    "converter.errors",
    "converter.limits",
    "converter.options",
    "converter.protocol",
    "converter.sandbox",
    "converter.validation",
]


def _loaded(modules: list[str]) -> set[str]:
    script = (
        "import importlib, json, sys\n"
        f"for name in {modules!r}: importlib.import_module(name)\n"
        "print(json.dumps(sorted({m.split('.')[0] for m in sys.modules})))\n"
    )
    completed = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        cwd=ROOT,
        env=child_env(),
        check=True,
        timeout=60,
    )
    return set(json.loads(completed.stdout))


def _all_modules() -> list[str]:
    names = []
    for path in sorted(PACKAGE.rglob("*.py")):
        parts = path.relative_to(ROOT).with_suffix("").parts
        names.append(".".join(parts[:-1] if parts[-1] == "__init__" else parts))
    return names


def test_cli_imports_no_native_parser_before_sandbox() -> None:
    loaded = _loaded(PRE_SANDBOX)
    assert not loaded & NATIVE
    assert not loaded & FORBIDDEN


def test_all_modules_import_without_backend_stack() -> None:
    modules = _all_modules()
    assert "converter.execute" in modules and "converter.probe" in modules
    loaded = _loaded(modules)
    assert loaded >= NATIVE
    assert not loaded & FORBIDDEN


def test_static_imports_are_stdlib_or_allowed() -> None:
    allowed = set(sys.stdlib_module_names) | NATIVE | {"converter"}
    for path in PACKAGE.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                roots = {alias.name.split(".")[0] for alias in node.names}
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                roots = {node.module.split(".")[0]}
            else:
                continue
            assert roots <= allowed, (path.name, roots - allowed)


def test_no_backend_files_are_referenced() -> None:
    for path in PACKAGE.rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        assert "from app" not in text and "import app" not in text, path.name
    assert not (Path(ROOT) / "converter" / "app").exists()
