# MI converter – Backend (FastAPI)

Serververarbeitung für die Website „MI converter“. Vertrag: [`../docs/backend/api-contract.md`](../docs/backend/api-contract.md), Plan: [`../docs/fastapi-backend-plan.md`](../docs/fastapi-backend-plan.md).

## Lokale Befehle (im Verzeichnis `backend/`)

```sh
uv sync                                   # Umgebung aus uv.lock (inkl. Dev-Werkzeuge)
uv run pytest                             # Tests
uv run ruff check . && uv run ruff format --check .   # Lint + Format
uv run mypy                               # Typprüfung (strict)
uv run python scripts/export_openapi.py   # openapi.json neu erzeugen (Test prüft Drift)

# Entwicklungsserver mit Auto-Reload (Doku unter http://127.0.0.1:8000/api/v1/docs)
CONVERTER_ENVIRONMENT=development CONVERTER_SESSION_COOKIE_SECURE=false \
CONVERTER_STORAGE_DIR=./.data/storage uv run uvicorn app.main:app --reload
```

`CONVERTER_ENVIRONMENT` ist standardmäßig `production` und verlangt dann `CONVERTER_SECRET_KEY` (≥ 32 Zeichen) und `CONVERTER_ALLOWED_ORIGINS`. Alle Einstellungen: `app/core/config.py`. Das Storage-Verzeichnis muss existieren (sonst meldet `/health/ready` `503`).

Container: `docker build -t converter-backend backend` (Nutzer `10001`, Port `8000`, Volume `/data/storage`).

## Struktur

```text
app/main.py          uvicorn-Einstieg (app.main:app)
app/factory.py       create_app(settings): Middleware, Fehlerhandler, Router
app/api/             Endpunkte (health), errors.py (Fehlercodes/-format), middleware.py
app/schemas/         Pydantic-Antwortmodelle (camelCase im JSON)
app/core/            config.py (Settings), logs.py (JSON-Logs), readiness.py (Ready-Checks)
app/storage/         Dateispeicher; checks.py prüft Beschreibbarkeit
app/db, jobs, worker, processing/   folgen ab B03–B08
migrations/          Alembic (ab B03)
scripts/             export_openapi.py
tests/               pytest
```
