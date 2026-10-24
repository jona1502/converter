> Legacy: FastAPI-Referenz und Rückweg. Standardbetrieb ist jetzt das Go-Backend in `server/`; siehe `docs/go-backend/operations.md`.

# MI converter – FastAPI

Installation, Architektur und Datenschutz: [Projekt-README](../README.md). Vertrag: [api-contract.md](../docs/backend/api-contract.md).

Python 3.13, reproduzierbare Abhängigkeiten über `uv.lock`. Im Verzeichnis `backend/`:

```sh
uv sync --frozen
uv run ruff check .
uv run ruff format --check .
uv run mypy
uv run pytest
uv run python scripts/export_openapi.py --check
uv run python scripts/smoke_stack.py --base-url http://localhost:8080
```

Tests benötigen PostgreSQL auf Compose-Port 55432 und Valkey auf 56379. Sie erzeugen und löschen eigene Testdatenbanken. `CONVERTER_TEST_DATABASE_URL` darf niemals auf Nutzdaten zeigen; Name muss `test` enthalten.

Der vollständige Linux-Stack wird im Projektverzeichnis mit `docker compose up -d --build --wait` gestartet. API allein verarbeitet keine Aufträge: Worker, Dispatcher und Cleanup gehören dazu. Windows dient als Entwicklungsumgebung; die Parser-Netzwerk-/Ressourcenisolation wird in Linux-Containern erzwungen.

Alle Variablen stehen in `app/core/config.py` mit Präfix `CONVERTER_`. Standardmodus `production` verlangt Secret, Secure-Cookie, erlaubte Origins und Datenbank. Readiness prüft Dateispeicher, DB, Broker und Formate; Liveness nur den API-Prozess. Interaktive Doku ist in Entwicklungsbetrieb unter `/api/v1/docs` abrufbar.

Nach Vertragsänderungen `uv run python scripts/export_openapi.py`, anschließend im Projektverzeichnis `npm run api:types`. CI prüft OpenAPI- und Typdrift. Der kleine Generator benötigt keine weitere JavaScript-Abhängigkeit.
