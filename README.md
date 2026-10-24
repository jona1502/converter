# MI converter

Deutschsprachige Astro/React-Website mit FastAPI-Backend für Bildkonvertierung, Komprimierung, Skalierung und PDF-Komprimierung. Die Website verarbeitet Dateien auf dem Server. Ein Upload beginnt erst nach einem ausdrücklichen Klick auf den Verarbeitungsbutton.

## Lokal starten

Voraussetzung: Docker mit Compose und laufender Linux-Container-Engine. Im Projektverzeichnis:

```sh
docker compose up -d --build --wait
```

Website: **http://localhost:8080**. Der Dienst `migrate` führt die Alembic-Migration aus und endet erfolgreich, bevor API und Worker starten.

```sh
docker compose ps
docker compose logs --tail 50 api worker dispatcher cleanup
docker compose down
```

`down` erhält die Volumes. Diese enthalten temporäre Dateien bzw. Auftragsmetadaten. Volumes nicht pauschal löschen, um Installationsprobleme zu beheben.

Compose ist für lokalen HTTP-Betrieb konfiguriert: lokale Zugangsdaten, Entwicklungssecret und Cookie ohne Secure. Für öffentliches Hosting sind individuelle Secrets, HTTPS, Secure-Cookies, erlaubte Origins und echte Betreiber-/Datenschutzhinweise erforderlich. Es erfolgt keine automatische Veröffentlichung.

## Architektur und Weg einer Datei

1. Nginx liefert den statischen Astro-Build und leitet `/api/v1/` an FastAPI weiter. Downloads sind keine öffentlichen Dateipfade.
2. FastAPI verwaltet eine anonyme Sitzung mit HttpOnly-Cookie und CSRF-Schutz. Jeder Auftragszugriff prüft den Besitzer.
3. Nach Klick auf den Verarbeitungsbutton werden Optionen und eine Datei streamend geprüft. Auftrag und Outbox werden gemeinsam in PostgreSQL angenommen; Antwort: `202`.
4. Der Dispatcher veröffentlicht die Auftrags-ID über Valkey (Redis-kompatibel) an Celery. PostgreSQL bleibt die Quelle für Status und Wiederanlauf.
5. Ein Worker beansprucht den Auftrag mit Lease. Ein separater Linux-Prozess verarbeitet ihn ohne Netzwerksockets und DB-/Broker-Secrets, mit Zeit-, Speicher- und Dateigrößenlimits.
6. Fertige Dateien werden synchronisiert und in der Datenbank veröffentlicht. Die Oberfläche fragt den Status ab und bietet autorisierte Downloads an.
7. Cleanup sperrt abgelaufene Aufträge und entfernt Dateien und Metadaten. Download- und alte Worker-Leases werden berücksichtigt.

Ein Bild entspricht einem Auftrag mit einem Ergebnis. Eine PDF erzeugt drei sequenzielle Varianten; fertige Varianten sind bereits während der übrigen Verarbeitung abrufbar.

## Funktionen und Grenzen

- Bilder: statische JPEG/PNG/WebP/GIF/BMP/ICO/AVIF als Eingabe; JPEG, PNG, WebP, BMP und ICO als Ausgabe. Codecs werden mit echten Rundreisen geprüft.
- Komprimierung: Qualität für JPEG/WebP, optional kleinere Abmessungen. PNG wird verlustfrei optimiert; keine wirkungslose Qualitätsanzeige.
- Skalierung: Prozent/Zielmaße, Seitenverhältnis standardmäßig erhalten, Vergrößerung nur ausdrücklich.
- PDF: high/balanced/small mit 300/150/100-DPI-Zielen und zusätzlichen Pixelgrenzen. Jede Variante beginnt beim Original. Keine Rasterung ganzer Seiten, OCR oder Verkleinerung von Schriften. Masken, Spezialfarbräume und unsicher unterstützte Filter bleiben unverändert.

Bilder: maximal 52.428.800 Bytes Eingabe, 40 MP, 16.384 px je Kante und 104.857.600 Bytes Ausgabe. Bis zu 30 Bilder je Stapel, zwei parallele Uploads und standardmäßig drei aktive Aufträge je Sitzung.

PDF: maximal 100.000.000 Bytes Eingabe, 300.000.000 Bytes über alle Ergebnisse und 40 MP je neu kodiertem Bild. Verschlüsselte oder nur durch Reparatur lesbare PDFs werden abgelehnt. Signaturen können ungültig werden; PDF/A-Erhalt ist nicht garantiert. Ergebnisse können größer werden; echte Größen werden angezeigt.

Startwerte: eine Stunde Gültigkeit, 5 GB gemeinsames Dateibudget, 50 aktive Aufträge insgesamt, zehn Erstellversuche pro Minute je Sitzung und Client-IP. Prozesszeitlimit: 120 s Bild, 300 s PDF. Linux-Parser: 1 GiB Adressraum; Workercontainer: 1,5 GiB. Konfiguration: `backend/app/core/config.py`.

Metadaten/Farbprofile können entfernt oder verändert werden. Kein geprüftes Verfahren zur Metadatenbereinigung. Server- und Browserencoder erzeugen nicht dieselben Bytes.

## Dateien und Löschung

Dateien und bereinigte Namen liegen temporär auf dem Server. Inhalte, Namen, Cookies und Tokens gehören nicht in Logs. Die Anwendung speichert keine Dateien oder Tokens in Web Storage/IndexedDB.

Entfernen/Reset fordert Serverlöschung an. Bei Uploadabbruch oder Verlassen der Seite ist dies nur möglich, soweit eine Auftrags-ID bekannt ist; eine zuverlässige Löschung beim Schließen des Browsers wird nicht versprochen. Die reguläre Gültigkeit bleibt die Rückfallebene.

Nach Ablauf/Löschung sind neue Downloads gesperrt. Aktive Downloads sind zeitlich auf 300 s begrenzt. Cleanup läuft minütlich; bei gesundem Stack ist das konfigurierte physische Löschfenster zehn Minuten. Crashreste behalten bis zum sicheren Ende des Parserzeitlimits ihre Speicherreservierung. Bei gestoppten Diensten, DB-Ausfall oder Dateisystemfehlern kann sich Cleanup verzögern; es wird beim Wiederanlauf erneut ausgeführt. Dateivolumes nicht in Langzeitbackups aufnehmen.

Hostingprotokolle, Impressum und vollständige rechtliche Datenschutzhinweise muss der Betreiber vor Veröffentlichung regeln.

## Entwicklung und Tests

Frontend: Node 24 LTS und npm. Backend: Python 3.13 und uv. Echte Integrationsprüfungen benötigen Docker/PostgreSQL/Valkey.

```sh
npm ci
npx playwright install chromium firefox webkit
npm run check
npm test
npm run build
node scripts/generate-api-types.mjs --check
```

Die ursprünglichen lokalen Engines unter `src/lib/image` und `src/lib/pdf` bleiben durch Browser-Unit-Tests geprüft. Die Website bietet keinen stillen lokalen Fallback.

```sh
docker compose up -d --wait db broker
cd backend
uv sync --frozen
uv run ruff check .
uv run ruff format --check .
uv run mypy
uv run python scripts/export_openapi.py --check
uv run pytest
```

Der Smoke-Test braucht den vollständigen Stack (`docker compose up -d --build --wait`) und prüft dann im Verzeichnis `backend` mit `uv run python scripts/smoke_stack.py` alle vier Werkzeuge über `http://localhost:8080`.

**Testdatenbanken:** pytest legt `converter_test` und eine Migrationstestdatenbank neu an und löscht deren bisherigen Inhalt. `CONVERTER_TEST_DATABASE_URL` darf ausschließlich eine Testdatenbank enthalten (Name muss `test` enthalten), niemals Nutzdaten. Limitprüfungen verwenden eine getrennte lokale Brokerdatenbank.

Die vollständigen E2E laufen gegen den echten Compose-Stack. PowerShell:

```powershell
$env:E2E_BASE_URL = 'http://localhost:8080'
npm run test:e2e
```

Für große Testläufe teilen sich viele Sitzungen eine IP. CI setzt beim Compose-Start deshalb `CONVERTER_IP_CREATES_PER_MINUTE`, `CONVERTER_SESSION_CREATES_PER_MINUTE` und `CONVERTER_SESSION_NEW_PER_MINUTE` explizit auf 1000. Die normalen Limits werden separat geprüft. Diese Testwerte nicht für öffentliches Hosting übernehmen.

Ohne `E2E_BASE_URL` startet Playwright nur den statischen Previewserver; Serverwerkzeuge benötigen eine API. WebKit unter Windows ersetzt kein echtes Safari/iPhone. Der tatsächliche GitHub-Actions-Lauf erfolgt erst nach einem später autorisierten Push.

## Im Code orientieren

- `backend/app/api` und `schemas`: HTTP, Besitzerprüfung, validierte Eingaben und Antworten.
- `backend/app/db`, `backend/migrations`: Modelle und nachvollziehbare Schemaänderungen.
- `backend/app/jobs`: Annahme, Outbox, Zustände, Recovery und Cleanup.
- `backend/app/worker`: Celery, Prozessüberwachung und Linux-Isolation.
- `backend/app/processing`: Bild-/PDF-Algorithmen ohne HTTP-/Datenbankwissen.
- `src/lib/api`: gemeinsamer Browserclient, Headerprobe und generierte Typen.
- `infra` und `compose.yaml`: lokaler Gesamtbetrieb.
- `docs/backend`: API-Vertrag, Commitlog und Machbarkeitsnachweis.

Zum Lernen zuerst Health-/Sitzungsroute, dann `POST /jobs` und den Weg über Outbox/Claim bis zur Verarbeitung lesen. `backend/scripts/smoke_stack.py` demonstriert Upload, Status, Downloadprüfung und Löschung. Bei Fehlern Browserantwort und `requestId`, dann API-/Worker-/Dispatcherlogs prüfen. Keine Dateiinhalte oder Secrets zum Debuggen protokollieren.
