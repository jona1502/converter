# Commitlog Go-Backend

Ein Eintrag je Arbeitspunkt aus [../go-backend-plan.md](../go-backend-plan.md), ohne eigenen Hash. Angegeben sind nur tatsächlich ausgeführte Prüfungen.

## G02

- **Änderungen:** Vorbereitete Go-Grundlage übernommen: Modul/Locks, Konfiguration, Standardbibliothek-HTTP-Router, Fehler-/Logging-/Healthmodell, typisierte API-DTOs, strikte Optionsvalidierung, kanonische Vertragsprüfungen und isolierter Go-Teststack. TypeScript-Generator liest den sprachunabhängigen Vertrag `api/openapi.json`.
- **Review:** Unabhängig durch `go_converter`; keine bestätigten hohen/mittleren Befunde. HTTP-/Readinessplatzhalter sind ausdrücklich noch keine vollständige API; Integration folgt G05/G08.
- **Prüfung:** Baseline `go test ./...`, `go vet ./...` und `go test -race ./...` im gepinnten Linux-Go-Image gegen eigenen PostgreSQL-/Valkey-Teststack bestanden. Foundation zusätzlich scoped durch Reviewer mit Race-Detector geprüft.
- **Grenze:** Laufender Produktstack bleibt bis zur vollständigen Go-Abnahme unverändert auf FastAPI/Celery. Keine Nutzdatenbank für Tests verwendet.

## G03

- **Änderungen:** Eigenständiger privater Python-Konverter mit ausschließlich Pillow/pikepdf als Produktabhängigkeiten, striktem begrenztem JSONL-Protokoll, einmaliger stdin-Anfrage und eigener Sandbox. Keine FastAPI-/SQLAlchemy-/Celery-/Redis-/Pydantic-Laufzeitimports. Vorhandene Bild-/PDF-Algorithmen und Tests übernommen; Ausgabe nur in bereits von Go angelegte private Dateien.
- **Review:** Hauptagent unabhängig vom Konverterautor: CLI, Ereignisgrenzen, Optionsmodelle, Sandbox, Budget und Dateizugriff gelesen. Native Ausgaben werden auf stderr umgeleitet; Ereignisse enthalten keine Pfade/Inhalte/Fehlermeldungstexte.
- **Prüfung:** Konverterautor: Ruff/Format/mypy grün; Windows 168 bestanden, 13 Linux-Sandboxfälle übersprungen. Gepinntes Linux-Testimage mit aktiver Seccomp-/RLIMIT-/Walltimer-/PDEATHSIG-Prüfung: 181 bestanden.
- **Grenze:** Netzwerk-/Ressourcenschutz ist für Linux vorgesehen; Windows ist Entwicklungsumgebung. Prozessgruppen-/Go-Adapterabnahme folgt G07.

## G03a – Arbeitsartefakte aus dem Index entfernen

- **Änderungen:** Während G03-Staging entstandenes lokales Integrationstestbinary wieder aus der Versionsverwaltung entfernt; `.data/`, Go-Testbinaries und lokale Buildausgaben werden ignoriert. Die lokale Testdatei bleibt erhalten.
- **Review:** `go_converter` bestätigte die gezielte Indexentfernung und Ignore-Regeln. Keine Produktcodeänderung und keine zusätzliche Testausführung erforderlich.

## G04

- **Änderungen:** pgx-Pool und schemaerhaltende SQL-Migrationen, Alembic-0003-Baseline, idempotente Requeue-Funktion, Besitzerabfragen, Sitzungs-/CSRF-Logik mit Python-Goldenfixtures und private Dateiablage mit fsync/atomaren Umbenennungen. Testdatenbankhelfer erlaubt ausschließlich eigene Testdatenbanken.
- **Review:** Hauptagent unabhängig vom vorbereiteten Claude-Code: Sessionhash/CSRF, SQL-Parameter, Migrationsübernahme, Download-Lease, Pfad-/Rechte-/fsync-Regeln und Testdatenabgrenzung gelesen. `go_converter` zusätzlich Storage/Jobs unabhängig geprüft.
- **Prüfung:** Go-Baseline einschließlich auth/store/storage/testdb/cmd-migrate gegen isolierten PostgreSQL-Stack grün; `go vet` und Race-Detector ohne Befund. Schema-Snapshot und vorhandene Alembic-Revision werden durch Migrationstests verglichen.

## G05

- **Änderungen:** Go-Annahmedienst mit Upload-/Speicherreservierungen, Aktivquoten, atomarer Finalisierung/Outbox, Fingerprints, stabiler Idempotenz, sicheren Namen und prozessübergreifenden Valkey-Limits. Fachliche Operationen sind getrennt von HTTP testbar; Handler werden nach dem Prozessadapter in G08 verdrahtet.
- **Review:** `go_converter` unabhängig, insbesondere Fehler bei unklarer Commitantwort. Behoben: nach möglicherweise erfolgreichem Commit keine angenommene Eingabedatei löschen. Advisorylock und unabhängiger Reconcile erhalten Dateien/Budget, wenn Datenbankzustand unklar bleibt. Prospektive Job-ID entspricht Reservierungs-ID, damit Cleanup unklare Promotionen zuordnen kann.
- **Prüfung:** Echte PostgreSQL-Regressionsprüfungen für parallele Annahme, verlorene Commitantwort, Replay/Konflikt und wiederholte Bereinigung; scoped `go test -race` und `go vet` grün. Kein Testzugriff auf Nutzdatenbank.

## G06

- **Änderungen:** PostgreSQL-Outbox als dauerhafte Queue ohne Celery, atomare Claims, Heartbeat, Publish/Finish, begrenzte Recovery und Prozesssteuerung mit Concurrency 1. Unklare Veröffentlichung und fehlgeschlagene Dateilöschung halten Reservierungen bis Recovery/Cleanup.
- **Review:** `go_converter` unabhängig; nach Commit-Uncertainty-Korrektur keine bestätigten hohen/mittleren Befunde im Jobs-/Runtimebereich.
- **Prüfung:** Jobs-/Store-/Storage-/Ratelimitprüfungen einschließlich Race und Vet grün; neue DB-/Workerregressionen prüfen Claims, Publish, Timeout, Cancel, exhausted/storage-full Claims und erhaltene PDF-Teilergebnisse.

## G07

- **Änderungen:** Begrenzter Go-Python-Adapter mit fester Interpreter-/Argument-/Umgebungs-Allowlist, JSONL-Validierung, Prozessgruppenabbruch, Parent-Death und zuverlässigem Wait. PDF-Retry erhält nur offene Stufen und Restbudget. Eigener Probezyklus publiziert atomare, versionierte Capabilitiesberichte unabhängig vom Verarbeitungsslot; Go-Workerbefehl integriert.
- **Review:** `go_jobs` unabhängig gelesen; keine bestätigten hohen/mittleren Befunde. Hauptagent hat Linux-Prozessgrenze zusätzlich gelesen.
- **Prüfung:** Prozess-/Protokolltests, Race und Vet grün; echte gehärtete Linuxintegration: drei Bildoperationen, PDF mit drei Stufen und Capabilitiesprobe bestanden. Fixturedateien bilden statische/animierte Codecs für Headerparität ab.

## G08

- **Änderungen:** Vollständige Go-HTTP-Endpunkte für Sitzung, Capabilities, Upload, Status, Cancel/Delete und autorisierte Downloads; echte Readiness in API-main. Begrenzter MIME-Headerguard vor Standardparser, Vorabreservierung, Header-/Animationsprobe einschließlich AVIF-Primärelement und Rücksetzen von HTTP-Keepalive-Deadlines.
- **Review:** Hauptagent unabhängig vom API-Autor: Besitzer-/CSRF-Prüfung, Transaktionsgrenzen, Multipart-/Deadline-/Header-/Downloadregeln gelesen und Korrekturen angefordert; `go_jobs` meldete ebenfalls Deadline-Reset. Letzter Subagent-Nachreview war wegen Nutzungslimit nicht vollständig verfügbar; keine erfundene weitere Freigabe.
- **Prüfung:** Autor: zehn Endpoint-/Header-/Golden-/Securitytests mit Race und Vet grün. Hauptagent: echter HTTP-Smoke für alle vier Werkzeuge erfolgreich; erster Gesamtbrowserlauf gegen Go: 176 bestanden, vier geräteabhängig übersprungen. Nach letztem Header-Hardening folgt erneute Abschlussprüfung G11.

## G09

- **Änderungen:** Go-Cleanup für Ablauf/Deletion, alte Arbeitsversuche, Download-Leases, Uploadreservierungen, verwaiste Dateien und Sitzungen. Dateien vor Bytefreigabe entfernen, unklare Promotionen anhand Reservierungs-/Job-ID sicher zuordnen. Eigener Cleanupbefehl mit begrenzten DB-Kontexten.
- **Review:** `go_converter` prüfte Cleanup/Jobs unabhängig und bestätigte nach Korrekturen keine hohen/mittleren Befunde; Hauptagent Integration zusätzlich gelesen.
- **Prüfung:** DB-/Raceprüfungen für Expiry/Delete während laufender Arbeit, Budgethold, Uploadreste, Download-Leases und wiederholten Neustart bestanden. Keine Löschung von Nutzdaten im Teststack.

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

## G01

- **Commit-Nachricht:** `docs(go): G01 Architektur Vertrag und Cutover festlegen`
- **Änderungen:** Auftrag `docs/go-backend-plan.md` aufgenommen. `docs/go-backend/architecture.md`: Go 1.27.3 mit per Digest gepinntem Build-/Testimage, Abhängigkeiten (pgx v5.11.0, go-redis v9.23.0, x/image v0.47.0, govulncheck v1.9.0; ≥ 7 Tage Karenz), Paketstruktur und Subagent-Zuständigkeiten, isolierte Testumgebung ohne Nutzdaten, Outbox als PostgreSQL-Queue mit Claim analog `runtime.claim()`, volle Besitzbedingung, Backoff bei technischen Fehlern, Capabilitiesbericht ohne Startkreis, Headerprobeplan, Cutover-/Rückwegverfahren ohne Volumen- oder Brokerlöschung. Wegwerf-Machbarkeitslauf `docs/go-backend/feasibility/`.
- **Autor/Review:** Hauptagent; unabhängiger Review-Subagent hat Dokument, Versionen und Machbarkeitslauf geprüft (Lauf mit/ohne `--init` selbst ausgeführt, Live-DB nur lesend). Behoben: Alembic-Revision heißt `0003` (nicht `0003_stale_attempts`), Besitzbedingung um `lease_expires_at`/`expires_at`/`cancel_requested_at` ergänzt, Claim mit Arbeitsreserve/`storage-full` und Zurücksetzen nicht veröffentlichter Ergebnisse ausgeschrieben, Backoff bei technischem Claimfehler, `delete`-Outboxeinträge abgegrenzt, `--init` in der Laufanleitung. Für spätere Schritte übernommen: Probe/Recovery in eigener Goroutine (G07), identische Speicherschlüssel für wechselseitiges Cleanup (G06/G09), bekannte Go-Decoderlücken JPEG/BMP/AVIF/ICO (G05), `Wait` bei jedem Abbruchpfad und `LockOSThread` für `Pdeathsig` (G07).
- **Prüfung:** `docker build` + `docker run --rm --init --network none --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true mi-converter-g01` → Ereignisse `progress`, `result`; Ausgabe JPEG 160×100, 1709 Bytes, vom Go-Decoder unabhängig gelesen, Parsergröße = Dateisystemgröße; „GO->PYTHON: OK“. Ohne `--init`: `fatal` (Sandbox lehnt PID-1-Elternprozess ab, erwartet). `gofmt -l` leer, `go vet` grün.
- **Grenzen:** Machbarkeitslauf nutzt noch `app.worker.child` aus dem FastAPI-Image; Cutover und Rückweg sind beschrieben, aber erst in G11 praktisch geprobt.

## G10

Go-Dockerimages, Standard-Compose, Vergleichsstack, Legacy-Rueckweg, Healthprobe, Nginx und gepinnte CI integriert. Lokaler Build und Healthchecks bestanden. Letzter unabhaengiger Infrastrukturreview wegen Subagent-Limit nicht verfuegbar; Hauptagent pruefte Betrieb. GitHub-CI nicht ausgefuehrt.

## G11

Finale HTTP-Kontexte begrenzt, Privacy-Allowlist und PDF-Hinweis geprueft, Smoke-/Cutover-/Messskripte integriert. Go Vet und Race vollstaendig gruen; finale Browserpruefung 176 bestanden / 4 uebersprungen. Echter isolierter Go-Python-Lauf und HTTP-Smoke fuer alle vier Werkzeuge bestanden. Cutover und Rueckweg mit bestehender Sitzung und wartendem Auftrag bestanden.
