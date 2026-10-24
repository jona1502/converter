# Commitlog Go-Backend

Ein Eintrag je Arbeitspunkt aus [../go-backend-plan.md](../go-backend-plan.md), ohne eigenen Hash. Angegeben sind nur tatsächlich ausgeführte Prüfungen.

## G00

- **Commit-Nachricht:** `chore(migration): G00 vorhandenen Converter-Stand sichern`
- **Änderungen:** Checkpoint der bisher uncommitteten B12-Arbeit: vollständiger Compose-Stack (Migration, API, Worker, Dispatcher, Cleanup, Nginx-Web), `infra/` (Webimage, Nginx mit CSP/Proxy), Wurzel-`.dockerignore`, CI-Workflow `verify.yml`, Backend-Dockerfile mit Migrationen, Redis-Readiness, echter Stack-Smoke `backend/scripts/smoke_stack.py`, auf echten Server umgestellte E2E-Tests inklusive `server-errors.spec.ts` und `E2E_BASE_URL` in Playwright, aktualisierte READMEs. Zusätzlich behoben: doppelt kodierter Umlaut im Session-Docstring (seit B09 committet) und damit im exportierten OpenAPI-Text. Nicht übernommen: `docs/handoff.md` (alte Übergabe), reine CRLF-Arbeitskopien von `e2e/{compress,convert,resize}.spec.ts` ohne Inhaltsänderung. Der Go-Plan folgt mit G01.
- **Autor/Review:** Änderungen stammen aus der vorherigen B12-Sitzung; Hauptagent hat sie integriert und gemessen. Unabhängiger Review-Subagent (nur lesend): keine kritischen/hohen Befunde. Behoben: README-Smoke-Aufruf stand hinter einem Start nur von `db broker`, Verweis auf eine nicht vorhandene Abschlussprüfung. Offen für G10/G11: Privacy-E2E prüft Nicht-API-Anfragen nur noch auf gleichen Origin statt Pfad-Allowlist und WebKit-CSP-Ausnahme unverankert; WebKit-Tastaturprüfung per `focus()`; PDF-Signaturhinweis nicht mehr geprüft; `migrate` ohne Ressourcenlimits, `web` ohne Healthcheck; Actions per Tag statt SHA gepinnt.
- **Prüfung (Hauptagent, 24.10.2026, Windows-Host, Docker 29.8.2):**
  - `uv sync --frozen`, `ruff check`, `ruff format --check`, `mypy` (82 Dateien), `export_openapi.py --check`: alle grün.
  - `pytest`: 187 bestanden, 1 übersprungen (POSIX-Rechtetest unter Windows) gegen dedizierte Datenbank `converter_test`.
  - `node scripts/generate-api-types.mjs --check` grün, `npm run check` 95 Dateien ohne Befunde, `npm test` 410 bestanden / 10 übersprungen.
  - `docker compose up -d --build --wait` (Volumes erhalten, Raten für Tests auf 1000/min) → alle Dienste healthy; Netzwerksperre des isolierten Kindprozesses: „network blocked“; `smoke_stack.py`: image-convert, image-compress, image-resize je 1 Ergebnis, pdf-compress 3 Ergebnisse.
  - `E2E_BASE_URL=http://localhost:8080 npx playwright test`: 176 bestanden, 4 übersprungen (Chromium, Firefox, WebKit, mobiles Chromium; übersprungen sind geräteabhängige Hover-/Touchfälle).
- **Grenzen:** Kein GitHub-Lauf des CI-Workflows (kein Push). Lastmessungen und vollständige B13/B14-Abschlussprüfung der FastAPI-Variante wurden nicht durchgeführt; G00 behauptet keinen Abschluss von B14.
