# Go-Backend – Übergabe und Umsetzungsauftrag für Claude

Stand: 24.10.2026. Dieser Plan beschreibt die nächste Migration; Go ist noch nicht implementiert.

## 1. Auftrag und verbindlicher Umfang

Baue das Backend von MI converter auf Go um. Go übernimmt HTTP-API, Sitzungen, Validierung, Dateiannahme, Auftragsverwaltung, Workersteuerung, Wiederanlauf und Cleanup. Astro/React und die vier vorhandenen Werkzeuge bleiben erhalten.

**Bewusste Grenze:** Die geprüften Pillow-/pikepdf-Algorithmen bleiben zunächst als private Python-Konvertierungsprozesse bestehen. Im Zielbetrieb gibt es keinen FastAPI-Server, keine Python-Geschäftslogik und keine Celery-Steuerung mehr. Es ist ein Go-Backend mit Python als internem Konvertierungswerkzeug, keine Behauptung einer vollständig Python-freien Anwendung. Ein späterer Ersatz der Bild-/PDF-Algorithmen durch Go ist außerhalb dieses Auftrags und benötigt einen separaten Format-/Qualitäts-/Lizenznachweis.

Ziele:

- Go anhand eines verständlichen echten Backends lernen.
- Alle derzeitigen Werkzeuge, Ausgabeformate, Schutzmechanismen und Nutzerabläufe erhalten.
- Ein schlanker Go-Codebestand mit wenig Abhängigkeiten; keine unnötigen Frameworkschichten.
- Die vorhandene JSON-API bleibt kompatibel; kein gleichzeitiges Frontend-Redesign.
- Vollständiger lokaler Compose-Betrieb und reproduzierbare Tests.

Keine Konten, Abos, Office-/Audio-/Videowerkzeuge, OCR, ZIP-Downloads oder öffentliche Bereitstellung ergänzen. Keine Leistungsverbesserung ohne Messung behaupten.

## 2. Vor Beginn: Arbeitsbaum sichern und tatsächlichen Stand prüfen

Das Repository befindet sich derzeit auf `feature/fastapi-backend`. B01–B11 sind committet, zuletzt `180823b` (B11). B12–B14 sind nicht vollständig abgeschlossen. **Es gibt wesentliche uncommittete Dateien, die zum funktionsfähigen Stand gehören.**

Insbesondere erhalten und prüfen:

- `compose.yaml`, `infra/`, `.dockerignore`, `.github/workflows/verify.yml`.
- README-Dateien, Backend-Dockerfile, dessen Ignoredatei, Readiness-/Download- und OpenAPI-Anpassungen.
- Migrierte E2E-Tests, `playwright.config.ts`, `e2e/server-errors.spec.ts`, `backend/scripts/smoke_stack.py`.
- `docs/handoff.md` ist eine alte ungetrackte Übergabe: nicht als aktuellen Stand interpretieren, nicht versehentlich committen oder entfernen.

Der Nutzer hat ausdrücklich eine einfache Startseite verlangt: **kein großer Hero-/Einleitungstext, kein Abschnitt „So funktioniert es“**. `src/pages/index.astro` zeigt direkt die Werkzeugauswahl. Diese Vereinfachung bewahren; nur kurze Uploadhinweise bei den Werkzeugen.

Bekannte bisherige Prüfnachweise (keine Garantie des aktuellen Arbeitsbaums):

- Lokale Engine: 410 Browser-Unit-Tests bestanden, zehn browserabhängig übersprungen.
- Echter Chromium-Serverlauf vor den letzten kleinen Oberflächenänderungen: 43 bestanden, ein geräteabhängiger Fall übersprungen.
- Lifecycle/Runtime/Migrationen: 22 gezielte Tests durch einen unabhängigen Reviewer bestanden.
- Echter HTTP-Smoke für Bildkonvertierung, Komprimierung, Skalierung und drei PDF-Downloads war erfolgreich.
- Vollständige Abschlussläufe wurden durch eine zwischenzeitlich nicht erreichbare Docker-Engine bzw. Gesprächswechsel unterbrochen. Keine unvollständigen Läufe als bestanden übernehmen.

G00 erstellt einen nachvollziehbaren Checkpoint der vorhandenen Änderungen. Nicht pauschal alles stagen. Danach neuer Branch `feature/go-backend` aus dem gesicherten Stand. Keine fremden Änderungen verlieren, keine Volumes/Nutzdaten löschen, keine alten Commits umschreiben, kein Push.

Go war bei letzter Prüfung auf dem Windows-Host nicht installiert. Verwende zunächst einen gepinnten Go-Build-/Testcontainer; eine Systeminstallation ist keine Voraussetzung. Aktuelle stabile unterstützte Go-Version bei Umsetzung aus offizieller Quelle wählen und reproduzierbar festlegen.

## 3. Bestehende Verträge und Einstiegspunkte

Vor Implementierung lesen:

- `docs/backend/api-contract.md`: Endpunkte, Fehler, Besitzerbindung, Optionen, Status und Grenzwerte.
- `backend/openapi.json`: bisher exportierter JSON-Vertrag.
- `backend/app/db/models.py` und `backend/migrations/versions/0001*` bis `0003*`: Datenmodell einschließlich `download_until` und `stale_attempts`.
- `backend/app/jobs/{acceptance,admission,queries,runtime,cleanup}.py`: Zustands-/Speicherregeln.
- `backend/app/core/{security,rate_limits,config}.py`: Cookie/CSRF, Rate-Limits und Konfiguration.
- `backend/app/worker/{runner,child,sandbox}.py`: Prozessprotokoll und Isolation.
- `backend/app/processing/images/pipeline.py`, `backend/app/processing/pdf/`: zu erhaltende Algorithmen.
- `backend/tests/`: Verhaltens- und Regressionstests; `docs/backend/feasibility/` als zusätzlicher technischer Hintergrund.
- `src/lib/api/`, `scripts/generate-api-types.mjs`, `e2e/`: Browservertrag und echte Abnahme.

Der alte FastAPI-Plan bleibt Historie und Referenz für Produktregeln. Dieser neue Plan ersetzt dessen Implementierungstechnologie, nicht die dort begründeten Korrektheitsanforderungen. Python-Code dient als Verhaltensreferenz, nicht als Vorlage für unidiomatische direkte Zeilenübersetzung.

## 4. Zielarchitektur

```text
Browser → Nginx → Go API → PostgreSQL (Sitzungen, Aufträge, Ergebnisse, Outbox)
                       ↘ Valkey (prozessübergreifende Rate-Limits/Sperren)

Go Worker → beansprucht Queue/Job in PostgreSQL → privater Python-Kindprozess
                                                Pillow / pikepdf
         ← begrenzte JSONL-Ereignisse ← Analyse / Fortschritt / Ergebnis
         → atomare Ergebnisveröffentlichung in PostgreSQL

Go Cleanup → Ablauf, Leases, StaleAttempts, Dateien und Speicherreservierungen
```

### Entscheidungen

- HTTP: Go-Standardbibliothek `net/http` mit expliziten Handlern/Middleware. Ein zusätzliches Webframework ist für diese API nicht erforderlich.
- PostgreSQL: `pgx`/`pgxpool`, explizites parametriertes SQL, keine zusätzliche ORM-Abstraktion. `go.mod`/`go.sum` sperren Abhängigkeiten.
- Valkey bleibt für die bereits vorhandenen atomaren Rate-Limits und Idempotenzsperren. Nicht gleichzeitig das Quotenmodell neu erfinden.
- **Celery und dessen Brokerprotokoll entfallen.** Die PostgreSQL-Outbox dient direkt als dauerhafte Queue. Go Worker pollt zunächst etwa einmal pro Sekunde; `LISTEN/NOTIFY` ist optional, kein Korrektheitsmechanismus.
- Worker übernimmt Claim und Abarbeiten des Outboxeintrags in derselben Transaktion mit `FOR UPDATE SKIP LOCKED`. Transaktion vor dem langen Konvertieren beenden. Nach Crash greift Lease-Recovery mit neuem Queueeintrag.
- Ein Go-Modul mit getrennten Befehlen `api`, `worker`, `cleanup`, `migrate`. Kein eigener Dispatcherdienst mehr im Zielbetrieb.
- Privates gemeinsames Dateivolume auf einem Host wie bisher; keine öffentliche Dateifreigabe oder S3-Migration.
- Keine zweite HTTP-Schnittstelle zum Python-Konverter. Go startet ein fest konfiguriertes Programm direkt, ohne Shell und ohne benutzergesteuerte Executable-/Argumentpfade.
- API-/Cleanup-Images nur mit Go und erforderlichen Laufzeitdateien. Workerimage zusätzlich mit minimalem Python und gesperrten Codec-Abhängigkeiten.
- Strukturvorschlag:

```text
server/
  go.mod, go.sum
  cmd/{api,worker,cleanup,migrate}/
  internal/
    config/ httpapi/ auth/ validation/
    store/ jobs/ ratelimit/ storage/ converter/
  migrations/
  tests/
converter/
  pyproject.toml, uv.lock
  converter/{cli,protocol,sandbox,errors}.py
  converter/processing/{images,pdf}/
  tests/
api/openapi.json
infra/
```

### Queuewechsel und Datenmigration

Ein Go-Worker kann keine bestehenden Celery-Nachrichten konsumieren. Kein gleichzeitiger alter Celery-/Dispatcherbetrieb und neuer PostgreSQL-Queuebetrieb auf derselben Auftragsdatenbank.

G01 legt ein getestetes lokales Wartungs-/Cutoververfahren fest: neue Annahmen stoppen, alte Verarbeitung beenden oder gezielt abbrechen, alte Dienste stoppen, Schema adaptieren, nichtterminalen Aufträgen einen eindeutigen neuen Queueeintrag geben, Go starten. Alte Broker-Nachrichten bleiben in einem getrennten Legacy-Keyspace oder werden später ausschließlich gezielt entfernt. Kein `FLUSHALL`, keine Volumenlöschung.

Sitzungstokens, Besitzer-IDs, gültige Ergebnisse, laufende Download-Leases und Idempotenzschlüssel erhalten. Kein stilles Löschen oder Zurücksetzen existierender Aufträge. Ein bewusstes Abbrechen beim Cutover muss sich als terminaler Status zeigen. Rollback vor Cutover proben; nach Go-Schemaänderungen nur mit nachgewiesener Schema-/Datenkompatibilität zurückrollen. Kein vermeintliches Rollback, das neue Aufträge verliert.

## 5. API- und Eingabekompatibilität

Diese Routen bleiben unter `/api/v1` erhalten:

| Route | Verhalten |
| --- | --- |
| `GET /session` | Anonyme Sitzung und CSRF-Token |
| `GET /capabilities` | Tatsächlich unterstützte Formate und konfigurierte Grenzen |
| `POST /jobs` | Ein Multipart-Upload mit `options` vor `file`, dauerhafte Annahme, 202/Replay 200 |
| `GET /jobs/{id}` | Besitzergebundener Zustand, Analyse, Ergebnisse und Ablauf |
| `POST /jobs/{id}/cancel` | Idempotenter Abbruch mit requested/completed/not-applicable |
| `DELETE /jobs/{id}` | Sofort sperren, verlässlich physisch aufräumen |
| `GET /jobs/{id}/results/{id}` | Autorisierter, zeitlich begrenzter Download |
| `GET /health/live`, `/ready` | Prozess bzw. benötigte Abhängigkeiten |

- CamelCase, Enumwerte, Fehlercodes, UTC-Zeitstempel, Header und semantische HTTP-Statuscodes beibehalten.
- Keine unbemerkte Abweichung durch Go-Zero-Values: fehlende Werte von explizitem `false`, `0` und `null` unterscheiden. Insbesondere Qualität 0 nicht durch einen Default ersetzen.
- Striktes JSON: unbekannte Felder, falsche Typen, nachfolgende JSON-Werte und ungültige Kombinationen ablehnen; Optionsgröße und Verschachtelung begrenzen. Endliche Zahlen, Listen ohne Duplikate und ICO-/Resize-Regeln explizit prüfen.
- Nicht einfach JSON in `map[string]any` dekodieren und ungeprüft weiterreichen. Typisierte DTOs mit separater fachlicher Validierung.
- Go-Rundung muss den bisherigen fachlichen Regeln entsprechen, nicht implizit einer abweichenden Sprachstandardfunktion folgen. Kanten, Pixelprodukte und Größen mit Overflowprüfung berechnen.
- OpenAPI nach G02 als sprachunabhängigen Vertrag nach `api/openapi.json` übernehmen. Generatorpfad und Driftprüfung gezielt anpassen; zur Laufzeit kein FastAPI-Export mehr nötig. Vertrags-/Fixturetests prüfen Go-DTOs und reale Antworten gegen den Vertrag.
- Dynamische Capabilities kommen aus einer echten Konverterprobe und werden beim Start/Readiness kontrolliert. APIimage braucht dafür keine native Bildbibliothek: Worker schreibt einen atomaren, versionierten Probebericht in das private gemeinsame Volume. Fehlender, inkompatibler oder veralteter Bericht muss Readiness scheitern lassen, nicht Formate erfinden. Startupreihenfolge darf keinen Kreis API-ready→Worker-start→Probe erzeugen.

## 6. Sicherheits- und Korrektheitsregeln

### Sitzungen, Upload und HTTP

- Kryptografisch zufällige Sitzung, nur Tokenhash in PostgreSQL. Gleiche Cookie-/CSRF-Berechnung und Secretkodierung wie bisher; sprachübergreifende Golden-Tests. `__Host-`-/Secure-Regeln in Produktion, lokale HTTP-Ausnahme ausdrücklich konfigurieren.
- Alle Status-, Download-, Cancel- und Deletezugriffe auf Besitzer prüfen. Fremde/fehlende/gelöschte Aufträge gleich behandeln.
- Keine pauschale CORS-Freigabe. Schreibzugriffe prüfen CSRF und erlaubte Origins. Proxy-IP nur von der konfigurierten Nginx-Gegenstelle übernehmen; keine globale Vertrauensfreigabe.
- `http.MaxBytesReader` plus `MultipartReader` für echte gestreamte Begrenzung. Nicht `ParseMultipartForm` oder `io.ReadAll` auf große Uploads verwenden. Unabhängig von Content-Length prüfen; abgeschnittenen Multipartabschluss und zusätzliche Teile erkennen.
- Goheaderprüfung darf kein bislang unterstütztes Format stillschweigend ausschließen. AVIF-/ICO-/Animationsprüfung muss technisch nachgewiesen werden; falls ein isolierter Probeprozess nötig ist, ihn ausdrücklich implementieren, ohne Python-Geschäftslogik/HTTP zurückzubringen. Grenzen vor vollständigem Dekodieren und erneut im Konverter prüfen.
- Uploadreservierung vor Schreiben, bei Abbruch/Fehler vollständig freigeben; notwendige temporäre Multipartdateien ebenfalls entfernen. Context-Abbruch nicht als erfolgreichen Auftrag melden.
- Alle Server-/DB-/Prozessoperationen mit begrenzten Contexts. Upload-Timeout passend für 100-MB-Dateien; kein pauschaler kurzer HTTP-Timeout, der große Uploads/Downloads ungewollt beendet. MaxHeaderBytes, ReadHeaderTimeout, IdleTimeout und Downloaddeadline gezielt setzen.
- Originalnamen ausschließlich bereinigt für Anzeige/Download, nie als Storagepfad oder Logfeld. Interne UUID-Pfade, private Dateirechte, atomare Veröffentlichung und Datei-/Verzeichnis-fsync erhalten.

### Aufträge, Quoten und Speicher

- Zustandsmaschine und Endzustände wie im bestehenden Vertrag, inklusive `partially_succeeded`, `cancelled`, `expired`.
- Jeder Claim/Heartbeat/Fortschritt/Abschluss muss Lease, aktuellen Zustand, Ablauf, Löschung und gegebenenfalls Abbruch prüfen. Keine lang laufende DB-Transaktion während Konvertierung.
- Gleichzeitige erstmalige Requests mit gleichem Idempotenzschlüssel serialisieren, danach erneut DB prüfen. Replay nur hashen, nicht neu spoolen; gleicher Schlüssel mit anderer Payload liefert Konflikt.
- Aktivquoten zählen Aufträge und laufende Uploadreservierungen in konsistentem Snapshot. Atomare Redis-Limits gelten über mehrere Go-APIprozesse hinweg; Ausfall schlägt geschlossen fehl.
- Reservierte Bytes werden erst nach tatsächlicher Dateientfernung freigegeben. **Bekannte bereits behobene Regression nicht wieder einbauen:** bei Recovery können alte Parserausgaben noch existieren; `stale_attempts` hält deren Reserve bis zur sicheren Bereinigung. Gleiches gilt für Ablauf/Löschung während laufender Verarbeitung.
- Bereits veröffentlichte PDF-Ergebnisse bei Recovery/Teilfehler nicht überschreiben. Pro Lease eigene Ergebnisdateien. Globales Budget, Ergebnisbudget und freier Speicher müssen auch bei parallelen Jobs eingehalten werden.
- Download-Lease vor Streaming committen; Dateihandle auch bei nie gestartetem Stream, Abbruch und Commitfehler schließen. Neue Downloads nach Ablauf sperren, bestehende zeitlich begrenzen.
- Cleanup wiederholbar und neustartfest; laufende/publizierte/alte geschützte Leasefiles erhalten. Bereinigung und Speicherfreigabe müssen Fehler und Wiederholung ohne Doppelabzug überstehen.

### Go ↔ Python-Prozessgrenze

- Neue kleine CLI hängt ausschließlich von Konvertercode, Options-/Grenzmodellen und Sandbox ab. Kein Import von `backend.app`, FastAPI, SQLAlchemy, Celery oder Redis im Zielkonverter.
- Eingabe einmalig als begrenztes JSON über stdin; Ereignisse als begrenzte JSONL-Zeilen über stdout. stderr nur bereinigt/diagnostisch und nie ungebremst in Nutzantworten/Logs übernehmen. Dateinamen, Inhalte und Secrets nicht protokollieren.
- Go validiert Ereignisart, result-ID, Reihenfolge, Größen und Metadaten; Pfade bleiben ausschließlich Go-seitig erzeugt. Ergebnisgröße aus dem Dateisystem erneut ermitteln; Parserbehauptung nicht vertrauen. Nach Erfolgsereignis darf der Parser diese Datei nicht weiter ändern.
- Kein Shellaufruf; `exec.CommandContext` mit festem Interpreter/Modul. Umgebungsvariablen auf eine kleine Allowlist reduzieren, keine DB-/Broker-Secrets vererben. Pipes parallel leeren, Zeilen-/Ereignislimits und Backpressure prüfen, Prozess immer `Wait`en.
- `CommandContext` allein ist keine vollständige Sandbox: Go beendet und wartet die gesamte Prozessgruppe; Linux-Netzwerk-/Speicher-/CPU-/Dateilimits und der unabhängige Kernel-Walltimer bleiben erhalten. Parent-Death-Signal, Prozessgruppen und PID-Rennen explizit testen.
- Harte Netzwerksperre des Parserprozesses gegen externe **und interne** Ziele erhalten (auch x32/alternative Syscallpfade). API/Go-Worker brauchen dagegen ihre internen DB-/Valkeyverbindungen.
- Workerconcurrency zunächst 1. Fehlende Pflichtcodecs sind ein Abnahmefehler. Keine neuen PDF-/Codec-Lizenzen ohne dokumentierte Prüfung.

## 7. Funktionen und Oberfläche bewahren

- Bildformate, Qualität, EXIF-Orientierung, sRGB/ICC-Handhabung, Alpha-Füllung, ICO-Einpassen, Resize und Grenzwerte wie bisher.
- PDF: drei Stufen aus dem Original, sichere Platzierungen/Transformationen, konservative Streams, keine vollständige Seitenrasterung. Signatur-/PDF-A-Grenzen ehrlich anzeigen. Echte Größen, auch wenn Ergebnis größer wird.
- Upload nur nach explizitem Klick. Kein automatischer Neuupload bei Netzwerkfehlern. Scheduling nur bei den vereinbarten expliziten 429-/503-Codes; Wartezustand und Reset bleiben bedienbar.
- Stabile Idempotenzschlüssel bei unklarer Antwort/manueller Wiederholung; Optionssnapshot für denselben Auftrag erhalten.
- Dateiauswahl vor dem Start erzeugt keinen Serverupload. Reset/Entfernen löscht bekannte Aufträge; beim Verlassen bleibt TTL Rückfallebene.
- Keine heroartigen Einleitungen oder Erklärkarten zurückbringen. Keine Implementierungsdetails in gewöhnlichen Nutzerabläufen. Deutsch, Tastatur/Fokus, mobile Darstellung und kurze ehrliche Uploadhinweise erhalten.

## 8. Geplante Commits

Ein gezielt gestagter Commit je Arbeitspunkt. Jeder enthält einen Eintrag in `docs/go-backend/commit-log.md`: Änderungen, Autor, unabhängiger Reviewer, tatsächlich ausgeführte Tests und Grenzen. Weitere bestätigte Fehler als G14+ behandeln, keine riesigen Sammelcommits. Gemeinsame Arbeitsdateien nicht versehentlich mitcommitten.

| ID | Commit-Nachricht | Inhalt und Abnahme | Abhängigkeit |
| --- | --- | --- | --- |
| G00 | `chore(migration): G00 vorhandenen Converter-Stand sichern` | Uncommittete B12-/Test-/Doku-/Infraänderungen prüfen, aktuellen Ausgangsstand messen und gezielt sichern; alte handoff-Datei auslassen; unvollständige Prüfungen offen benennen | – |
| G01 | `docs(go): G01 Architektur Vertrag und Cutover festlegen` | Neuen Featurebranch, Go-Version/Abhängigkeiten, Queuewechsel, Daten-/Rollbackverfahren und Zuständigkeiten festlegen; echter Machbarkeitslauf Go→isolierter Python-Konverter→gültige Datei | G00 |
| G02 | `feat(go): G02 API-Grundlage und Vertragsprüfungen ergänzen` | Go-Modul, Konfiguration, Health, Fehlerformat, Logs, Servergrenzen, kanonisches OpenAPI und DTO-/Typdriftprüfung; Go-Build/Tests im Container | G01 |
| G03 | `refactor(converter): G03 Python-Konvertierung unabhängig kapseln` | Bestehende Bild-/PDF-Algorithmen als private CLI ohne FastAPI/DB/Celery extrahieren, Protokoll/Sandbox/Dependencies isolieren; bisherige Codec-/Render-/Strukturtests grün | G01 |
| G04 | `feat(go): G04 Datenbank Sitzungen und Dateispeicher ergänzen` | pgx, schemaerhaltende Migrationen, Session/CSRF-Golden-Tests, private Dateien und sichere Download-Leases; echte PostgreSQL-Tests | G02 |
| G05 | `feat(go): G05 Uploads Auftragsannahme und Quoten ergänzen` | Striktes Multipart/Optionsmodell, Headerprobe, dauerhafte Annahme/Idempotenz/Outbox, Raten und Quoten; Teilupload/Replay/Races/Ownerchecks | G03, G04 |
| G06 | `feat(go): G06 dauerhafte Queue Worker und Recovery ergänzen` | PostgreSQL-Queue ohne Celery, atomare Claims/Heartbeat, begrenzte Wiederholung, Cancel und StaleAttempts; Doppelworker-/Crash-/Budgettests | G05 |
| G07 | `feat(go): G07 Konverterprozess sicher integrieren` | Go-Prozessüberwachung, begrenztes Ereignisprotokoll, Capabilitiesbericht, Limits und atomare Veröffentlichung; echter Bildauftrag bis Download | G03, G06 |
| G08 | `feat(go): G08 vier Werkzeuge vollständig bereitstellen` | Konvertieren/Komprimieren/Skalieren und drei PDF-Varianten, Analyse/Status/Teilfehler/Downloads vollständig kompatibel; unabhängiges Outputparsing | G07 |
| G09 | `feat(go): G09 Ablauf Cleanup und zuverlässige Löschung ergänzen` | Go-Cleanup, Upload-/Crashreste, Download-/Workerleases, physische Löschung vor Budgetfreigabe; Neustart und Rennbedingungen | G08 |
| G10 | `build(go): G10 Compose und CI auf Go umstellen` | Go-API/Worker/Cleanup/Migrate-Images, minimales Python nur im Worker, neue Startfolge/Probe, unveränderte URL8080, gepinnte Images und CI | G09 |
| G11 | `test(go): G11 Kompatibilität Wiederanlauf und Last prüfen` | Gegenüber Ausgangsstand vergleichen, vollständige Matrix aus Abschnitt10, dokumentierte Messungen und Regressionfixes | G10 |
| G12 | `refactor(go): G12 FastAPI und Celery aus dem Zielbetrieb entfernen` | Nach Paritätsnachweis alte HTTP-/Steuerungslaufzeit und unbenutzte Abhängigkeiten entfernen; historische Migrationen/Fixtures bewahren; Neustart und Cutover erneut testen | G11 |
| G13 | `docs(go): G13 Betrieb Lernpfad und Abschlussreview dokumentieren` | README, Architektur, API, Laufzeitgrenzen, vollständiger Prüfbericht, Go-Lernpfad, Rollback-/Cutoverhinweise und unabhängige Abschlussprüfung | G12 |

G02 und G03 können parallel entstehen. G04 kann nach stabilem G02-Vertrag parallel zur Konverterextraktion laufen. Tests parallel nach Dateizuständigkeit entwickeln. G00 ist ein Checkpoint, keine Behauptung, dass FastAPI B14 schon vollständig abgeschlossen war.

## 9. Verbindlicher Subagent-Workflow für Claude

Hauptagent koordiniert und nutzt ausdrücklich Subagents. Bei drei freien Subagent-Slots:

1. **API/Vertrag:** `server/internal/{httpapi,auth,validation,config}`, DTOs und zugehörige HTTP-Tests.
2. **Jobs/Storage:** `server/internal/{store,jobs,storage,ratelimit}`, SQL/Migrationen, Worker/Cleanup und DB-/Concurrencytests.
3. **Konverter/Integration:** `converter/`, Go-Python-Protokoll, Codec-/PDF-Regressionstests und echte Integration.

Hauptagent besitzt gemeinsame Dateien: `go.mod/go.sum`, OpenAPI, Compose, CI, README, Commitlog. Einzelne Dateien können ausdrücklich delegiert werden; nie gleichzeitig bearbeiten lassen.

- Vor jedem Auftrag Scope, Vertrag, Dateigrenzen und Fertigkriterien nennen.
- Keine parallelen Git-Mutationen. Nur Hauptagent staged/committet; keine Subagent-Pushes.
- Isolierte Worktrees verwenden, wenn sinnvoll verfügbar; sonst strikte getrennte Dateibereiche.
- Vor jedem Implementierungscommit unabhängiges Review durch einen anderen Agenten als den Autor. Slots durch Rollenwechsel für Review freimachen. Bestätigte Blocker beheben und nachprüfen.
- Subagents melden Tests, Risiken und Vertragsabweichungen konkret. Hauptagent prüft Integration zusätzlich.
- Review-/Werkzeug-/Nutzungslimits ehrlich angeben. Keine Reviews oder Prüfergebnisse erfinden; bei ausgeschöpften Agentlimits den überprüften Stand sauber sichern und offene Arbeit benennen.
- Keine erneuten Freigaben für bereits autorisierte lokale Implementierungsschritte verlangen. Öffentliche Bereitstellung und Push sind nicht beauftragt.

## 10. Prüfstrategie und Definition of Done

### Go und Vertrag

- `gofmt` sauber, `go vet ./...`, `go test ./...`, `go test -race ./...`, unterstützte Sicherheitsprüfung wie `govulncheck` aus offizieller Quelle und gepinnte Toolversionen.
- Go-Racetests in einem dafür geeigneten Linux-Buildimage ausführen; nicht behaupten, dass ein CGO-freier Minimalruntimecontainer den Race-Detector automatisch unterstützt.
- Echte PostgreSQL-/Valkeytests statt SQLite-/In-Memoryersatz für Sperren und Transaktionen. Explizite Testdatenbanken; niemals Nutzdaten leeren.
- Migrationsprüfung aus leerer DB **und** vorhandenem Alembic-0003-Stand. SQL-Constraints, Tabellen und aktive Dateireferenzen erhalten; Versionsmapping und Migration einmalig/sperrend ausführen.
- Vertragsfixtures: gültige/ungültige Optionen, fehlend/null/false/0, Enum-/Typ-/Listenfehler, Status/Fehler/Header/Cookies, CSRF-Secret- und Hashkodierung zwischen Python und Go.
- OpenAPI-/TypeScriptdrift muss CI erkennen. Browserclient darf keine stillen Go-Sonderfälle benötigen.

### Verhalten und Robustheit

- Jede Operation: echter Upload→dauerhafter Auftrag→Go-Worker→isolierte Konvertierung→gültiger Download→Löschung.
- Gleichzeitige Claims, doppelte Queuezustellung, leere Queue, DB-Ausfall bei Annahme/Veröffentlichung, API-/Worker-/Cleanup-Neustart, Leaseverlust und begrenzte Recovery.
- Cancel/Delete/Expiry gegen gleichzeitig fertig werdenden Worker; keine späte Veröffentlichung. Bereits fertige PDF-Stufen bei späterem Fehler erhalten.
- Speicher voll, Output zu groß, Pixellimit, Animation, Verschlüsselung, beschädigte Dateien, fehlende Codecs, Timeout/OOM, Pipe-Flut/ungültige JSONL-Ausgaben und Kindprozessabsturz.
- StaleAttempt hält tatsächliche Crashrestbytes bis Dateientfernung; Tests müssen auch Ablauf und Löschung laufender Jobs abdecken.
- Fremde Sitzung und CSRF, Token-/Pfadmanipulation, Multipart ohne/falschen Content-Length, abgebrochener Upload, Quoten über mehrere APIprozesse und gefälschte Proxyheader.
- Echte Linuxprobe für Netzwerksperre, Kernel-Walltimer, Prozessgruppen und Parent-Death. Nur einen vom Go-Context abgebrochenen Sleep zu testen reicht nicht für Sandboxabnahme.
- Bilder semantisch prüfen: Format, Dimensionen, Orientierung, Alpha, ICO, Qualität; keine Byteidentität verschiedener Encoder voraussetzen.
- PDFs mit Masken, Spezialfarbräumen, geteilten Bildern, Form-XObjects, Text/Vektoren/Formularen/Links/Outlines; unabhängiges Rendering und Strukturprüfungen erhalten.

### Frontend, Betrieb und Messungen

- Alle vier Browserprofile gegen echten Compose-Produktionsstack: Chromium, Firefox, WebKit und mobiles Chromium. Keine ausschließlich gemockte Abnahme.
- Keine Uploads vor ausdrücklichem Start, keine unerlaubten Fremdverbindungen oder Dateipersistenz im Browserstorage; Scheduling, manueller Retry, Reset, Ablauf und Downloads prüfen.
- Einfache Startseite, Tastatur/Fokus, 320-px-Ansichten, Dark Mode und axe prüfen. Kein Wiederaufbau entfernter Einleitungs-/Anleitungsabschnitte.
- Neue Installation mit einem dokumentierten Compose-Start; Neustart ohne stillen Verlust angenommener Aufträge. Cutover/Queuewechsel praktisch testen.
- Auf gleicher Maschine und mit denselben Fixtures messen: API-Grundspeicher, Upload-/Statuslatenz, Verarbeitungsdauer und Spitzenspeicher. API und Konverterwerte trennen. Go-Erfolg heißt Funktionsparität, nicht ein vorab versprochenes Tempo.
- Keine offenen bestätigten kritischen/hohen Befunde. Kleinere Abweichungen begründen, dokumentieren und die API nicht zur Grünfärbung von Tests abschwächen.

## 11. Abschlusslieferung

Code, Container, Migrationen, gesperrte Abhängigkeiten, CI, Tests und `docs/go-backend/release-review.md` mit tatsächlich ausgeführten Befehlen/Ergebnissen. README klar: Go steuert das Backend, Python bleibt im internen Konverter. Nicht ausgeführte Prüfungen, Grenzen und Veröffentlichungsaufgaben benennen.

Kurzer Lernpfad im README: HTTP-Handler → validiertes DTO → Service/Transaktion → Queueclaim → Prozessereignis → veröffentlichter Download. Go-Contexts, Fehlerbehandlung, Goroutine-Lebensdauer und Transaktionsgrenzen am konkreten Ablauf erklären. Keine unnötige Architektur nur zum Demonstrieren von Patterns einbauen.

## 12. Offizielle Ausgangsquellen

Bei G01 aktuelle kompatible Versionen und konkrete APIs prüfen:

- Go HTTP: https://pkg.go.dev/net/http
- Go-Prozessaufrufe/Contexts/Wait: https://pkg.go.dev/os/exec
- PostgreSQL-Treiber: https://github.com/jackc/pgx
- Go-Versionen: https://go.dev/dl/
- Bestehende Konverterreferenzen: `docs/backend/feasibility/README.md` und dortige offizielle Pillow-/pikepdf-Quellen.

## Direkt an Claude übergeben

> Setze `docs/go-backend-plan.md` vollständig in diesem Repository um. Beginne mit G00: den vorhandenen uncommitteten Converter-Stand prüfen und gezielt sichern; nichts verwerfen und die alte `docs/handoff.md` unangetastet lassen. Danach auf `feature/go-backend` Go für API, Jobs, Workersteuerung und Cleanup einführen. Die geprüften Python-Bild-/PDF-Algorithmen bleiben als isolierte private CLI erhalten; FastAPI und Celery entfallen aus dem Zielbetrieb. Halte API-/Funktionsparität, die einfache Startseite ohne Hero oder „So funktioniert es“, die geplanten Commits G00–G13 und das Commitlog ein. Nutze ausdrücklich Subagents mit getrennten Zuständigkeiten und unabhängigen Reviews. Arbeite bis zur getesteten lokalen Compose-Integration, prüfe den Daten-/Queue-Cutover und dokumentiere echte Ergebnisse. Keine Pushes, keine öffentliche Bereitstellung, keine Nutzdaten-/Volumenlöschung und keine erfundenen Tests oder Reviews.
