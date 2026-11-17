# Go-Backend – Architektur, Vertrag und Cutover (G01)

Stand: 24.10.2026, Branch `feature/go-backend` (aus G00 `356b69f`). Auftrag und Abnahme: [../go-backend-plan.md](../go-backend-plan.md). Produktregeln und Grenzfälle bleiben in [../backend/api-contract.md](../backend/api-contract.md) verbindlich; dieses Dokument legt nur die neue Implementierungstechnologie, den Queuewechsel und das Betriebsverfahren fest.

## 1. Versionen und Abhängigkeiten

Gewählt nach offiziellen Quellen am 24.10.2026 (`https://go.dev/dl/?mode=json`, `proxy.golang.org/<modul>/@latest`). Wie beim Python-Lock gilt eine Karenz von mindestens sieben Tagen zwischen Veröffentlichung und Aufnahme.

| Baustein | Version | Grund |
| --- | --- | --- |
| Go | 1.27.3 (aktuell stabil; 1.26.10 vorherige Linie) | `go.mod`: `go 1.27.3`, keine `toolchain`-Automatik |
| Build-/Testimage | `golang:1.27.3-trixie@sha256:fbb7ae40b62ff8afe31662df570d39b4f5052ac32b90dae8e60d7657a20a74f4` | Race-Detector braucht CGO/glibc; gleiches Debian wie das Python-Image |
| `github.com/jackc/pgx/v5` | v5.11.0 (07.09.2026) | `pgxpool`, explizites SQL, keine ORM |
| `github.com/redis/go-redis/v9` | v9.23.0 (05.10.2026) | Valkey-kompatibel, Lua-Skripte für atomare Limits |
| `golang.org/x/image` | v0.47.0 (09.10.2026) | nur `webp`/`bmp`-Headerprüfung (`DecodeConfig`), BSD-3 |
| `golang.org/x/vuln/cmd/govulncheck` | v1.9.0 (11.10.2026) | Werkzeug, nicht im Modul-Laufzeitgraph |

Alles andere aus der Standardbibliothek: `net/http` (Routing über `http.ServeMux`-Muster), `log/slog` (JSON-Logs), `crypto/*`, `mime/multipart`, `os/exec`, `encoding/json`, `embed` (SQL-Migrationen). UUIDv4 aus `crypto/rand` statt einer zusätzlichen Bibliothek. Kein Webframework, keine ORM, kein Migrationsframework. Laufzeitimages für API/Cleanup/Migrate: statisch gebaute Binärdatei (`CGO_ENABLED=0`) auf einem minimalen, per Digest gepinnten Basisimage; das Workerimage übernimmt das bestehende Python-Image (`python:3.13-slim-trixie`, `uv.lock`) nur mit Konvertercode.

## 2. Struktur und Zuständigkeiten

```text
server/                 Go-Modul github.com/mi-converter/server (nicht veröffentlicht)
  cmd/{api,worker,cleanup,migrate}/   je ein schmaler main mit Konfiguration und Signalbehandlung
  internal/config        Umgebungsvariablen CONVERTER_*, gleiche Namen und Defaults wie bisher
  internal/httpapi       Handler, Middleware (Request-ID, Header, Logs, Fehlerformat)
  internal/auth          Sitzung, CSRF, Origin, Client-IP hinter Proxy
  internal/validation    typisierte Options-DTOs, strikter JSON-Decoder, Header-/Formatprobe
  internal/store         pgx-Zugriffe, Transaktionen, SQL
  internal/jobs          Annahme, Claim, Recovery, Zustandsregeln, Cleanup-Logik
  internal/ratelimit     Valkey-Skripte (Raten, Idempotenzsperren), fail-closed
  internal/storage       private Dateiablage, atomare Veröffentlichung, fsync
  internal/converter     Kindprozess, JSONL-Protokoll, Capabilities-Bericht
  migrations/            eingebettete SQL-Dateien
converter/              private Python-CLI (Pillow/pikepdf), ohne FastAPI/SQLAlchemy/Celery/Redis
api/openapi.json        kanonischer, sprachunabhängiger Vertrag (ab G02)
```

Subagent-Zuständigkeiten (Plan Abschnitt 9): API/Vertrag (`config`, `httpapi`, `auth`, `validation`), Jobs/Storage (`store`, `jobs`, `storage`, `ratelimit`, `migrations`, `cmd/worker|cleanup|migrate`), Konverter/Integration (`converter/`, `internal/converter`). Der Hauptagent besitzt `go.mod`/`go.sum`, `api/openapi.json`, Compose, CI, READMEs und Commitlogs und ist allein für Git zuständig. Review immer durch einen anderen Agenten als den Autor.

## 3. Tests ohne Nutzdaten

Go-Tests laufen im Buildimage gegen einen **eigenen** Compose-Testprojekt-Stack (`mi-converter-test`, PostgreSQL/Valkey auf tmpfs, eigene Ports, keine benannten Volumes). Die Nutzdatenbank `mi-converter_db-data` und das Dateivolume `mi-converter_files` werden von Tests nie verwendet. Testdatenbanknamen müssen `test` enthalten; Testhelfer verweigern andere Namen. Die bestehenden Python-Tests behalten bis G12 ihre `converter_test`-Datenbank.

## 4. Queue ohne Celery

Die bestehende Tabelle `outbox` wird zur dauerhaften Queue. Ein Eintrag `kind = 'dispatch'` mit `published_at IS NULL` ist ein offener Queueeintrag; `published_at` bedeutet ab dem Cutover „vom Go-Worker übernommen“ statt „an Celery gesendet“. Das Schema bleibt dafür unverändert, wodurch der Rückweg (Abschnitt 6) ohne Datenkonvertierung möglich ist.

Claim (eine kurze Transaktion, danach Commit **vor** dem Konvertieren), fachlich identisch mit `runtime.claim()`:

1. `SELECT id, job_id FROM outbox WHERE kind='dispatch' AND published_at IS NULL AND available_at <= now() ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`.
2. Auftrag `FOR UPDATE` lesen. Nicht beanspruchbar, wenn `state <> 'queued'`, `deleted_at`/`cancel_requested_at` gesetzt, `expires_at <= now()` oder `attempts >= max_attempts`.
3. Arbeitsreserve per bedingtem Update auf `storage_usage` reservieren (Bild `image_max_output_bytes`, PDF `max(0, pdf_max_results_total_bytes - (reserved_bytes - input_size))`). Reicht das Budget nicht: Auftrag `failed(storage-full)`, `finished_at = now()`.
4. Sonst `state='running'`, `phase='analyze'`, neues `lease_token`, `working_bytes`, `lease_expires_at = now() + Lease`, `heartbeat_at = started_at = updated_at = now()` (wie Python bei jedem Claim überschrieben), `attempts+1`, `version+1`; alle nicht `succeeded` Ergebniszeilen zurück auf `pending` ohne Fehlercode – bereits veröffentlichte PDF-Stufen bleiben unangetastet.
5. Eintrag verbrauchen: `published_at = now()`, `attempts+1`. Commit.

- Scheitert der Job-Claim fachlich (Duplikat, abgebrochen, gelöscht, abgelaufen), wird der Eintrag trotzdem verbraucht; der Zustand in `jobs` bleibt die einzige Wahrheit.
- Scheitert die Transaktion technisch (SQL-/Verbindungsfehler), setzt eine separate Transaktion `attempts`, `last_error` (nur Fehlerklasse) und `available_at` mit Backoff (2^n s, höchstens 60 s) wie der bisherige Dispatcher – keine Endlosschleife im Sekundentakt.
- `kind='delete'`-Einträge (aus `mark_deleted`) liest und verbraucht Go nicht; die Löschung läuft über `deleted_at` und Cleanup, die Einträge verschwinden per `ON DELETE CASCADE` mit dem Auftrag. „Offen“ heißt immer `kind='dispatch' AND published_at IS NULL`.
- Polling etwa 1 s bei leerer Queue, sofort weiter nach einem Treffer; `LISTEN/NOTIFY` ist höchstens Beschleunigung.
- Besitzbedingung für Heartbeat, Fortschritt, Veröffentlichung und Endzustand ist der volle `owned()`-Ausdruck: `id=$job AND state='running' AND lease_token=$eigenes AND lease_expires_at > now() AND deleted_at IS NULL AND expires_at > now()`; Heartbeat, Fortschritt und Veröffentlichung zusätzlich `cancel_requested_at IS NULL`. Eine abgelaufene, noch nicht zurückgeholte Lease kann so weder verlängert noch genutzt werden.
- Recovery übernimmt der Go-Worker (bisher Dispatcher) in einer eigenen Goroutine unabhängig vom Konvertierungsslot: abgelaufene Lease → `queued` + **neuer** Outbox-Eintrag in derselben Transaktion bzw. `failed(worker-failed)`/`cancelled`/`expired`; Crashreste werden über `stale_attempts` reserviert, bis Cleanup sie physisch entfernt hat.
- Speicherschlüssel (`jobs/<job>/input`, `jobs/<job>/results/<result>/<lease>`, `spool/<reservation>`) und `stale_attempts`-Semantik bleiben identisch, damit Go- und Python-Cleanup Reste des jeweils anderen Betriebs korrekt aufräumen (Rückweg). Ein Test sichert das.
- Workerconcurrency per `WORKER_CONCURRENCY` (Standard 1): so viele Slots claimen parallel aus derselben Outbox. Mehrere Slots und mehrere Workerprozesse sind durch `SKIP LOCKED` und bedingte Updates sicher; Speicher-/CPU-Grenzen des Worker-Containers beim Erhöhen mitdenken. Die Queue ist begrenzt durch `GLOBAL_MAX_ACTIVE_JOBS`/`SESSION_MAX_ACTIVE_JOBS` (Annahme liefert sonst `server-busy`).
- Fortschritt und Warteposition laufen über das bestehende Polling (`GET /jobs/{id}`) im freien `progress`-Objekt, ohne Vertragsänderung: wartende Aufträge melden `{"step":"queue","position":N}` (1 = nächster Auftrag, gezählt über offene Dispatch-Einträge in `id`-Reihenfolge), laufende Audioaufträge `{"step":"encode","current":Frames,"total":Frames}` (gedrosselt, `current <= total`), PDF-Aufträge wie bisher je Stufe. Ohne Zähler bleiben die groben `phase`-Werte. Abbrechen: `POST /jobs/{id}/cancel` (queued sofort, running per Abbruchwunsch).

## 5. Go ↔ Python-Grenze

Machbarkeitslauf (G01): [feasibility/](feasibility/). Eine statische Go-Binärdatei startet im bestehenden Backendimage `python -m app.worker.child` per `exec.CommandContext` ohne Shell, mit fester Umgebung (`PATH`, `LANG`), eigener Prozessgruppe (`Setpgid`), `Pdeathsig=SIGKILL` (gilt je Thread: im Produktcode `runtime.LockOSThread` um `Start`), `Cancel` auf die ganze Gruppe und `WaitDelay`. Eingabe einmal als JSON über stdin, Ereignisse als JSONL mit 64-KiB-Zeilenlimit und strikter Struktur (`DisallowUnknownFields`). Ergebnisgröße aus dem Dateisystem, Format unabhängig per Go-Decoder geprüft.

Ergebnis im Container `--network none --read-only --cap-drop ALL --security-opt no-new-privileges`, Nutzer 10001:

```text
Ereignis: progress
Ereignis: result
Ausgabe: jpeg 160x100, 1709 Bytes (Parser meldete 1709), details={…"sourceWidth":320,"sourceHeight":200…,"qualityApplied":true}
GO->PYTHON: OK
```

Festgestellte Bedingung: Ohne `--init` ist der Go-Prozess PID 1, und die Python-Sandbox bricht bewusst geschlossen ab (`getppid() == 1` gilt als „Elternprozess bereits beendet“). Der Go-Worker läuft deshalb immer mit Init-Prozess (`init: true` in Compose); der Test dafür bleibt Teil der Sandboxabnahme.

Weitere Festlegungen:

- G03 extrahiert die Algorithmen nach `converter/` mit eigener CLI `python -m converter.cli`; bis dahin bleibt `app.worker.child` die Referenz. Protokollversion als Feld im Request und im Capabilitiesbericht.
- Go erzeugt alle Pfade und die leeren Ergebnisdateien (`O_EXCL`, `0600`), der Parser schreibt nur hinein. Nach einem `result`-Ereignis prüft Go Größe und Grenzwerte, `fsync`t und veröffentlicht; die Datei gehört ab dann nicht mehr dem Parser (der Prozess ist bei Bildern beendet, bei PDF wird jede Stufe in eine eigene Datei geschrieben).
- stderr wird nur begrenzt gelesen und verworfen bzw. als Längenzähler protokolliert, nie im Klartext.
- Seccomp-Netzsperre, `RLIMIT_*`, Kernel-Walltimer (`alarm`) und Parent-Death bleiben im Python-Kindprozess; Go ergänzt Prozessgruppen-Kill und eigene Zeitlimits.

### Capabilities ohne Python in der API

Der Worker führt beim Start und danach alle 5 Minuten – in einer eigenen Goroutine mit eigenem Zeitlimit, unabhängig vom Konvertierungsslot, damit lange PDF-Folgen den Bericht nicht veralten lassen – eine echte Rundreise (kleine Fixtures je Format) durch und schreibt `capabilities.json` atomar (Temp-Datei, `fsync`, `rename`) in das private Volume: Schemaversion, Protokollversion, Erzeugungszeit, Formate. Die API liest diesen Bericht für `/capabilities` und `/health/ready`; fehlend, falsche Version, Pflichtformat fehlt oder älter als 15 Minuten → `capabilities: fail`. Startreihenfolge: `migrate` → `worker` (Probe) → `api` (ready) → `web`; der Worker hängt nicht von der API ab, also kein Kreis.

### Headerprobe in der API

Die bisherige API nutzt Pillow nur zum Lesen von Kopfdaten. Go prüft ohne Dekodieren: JPEG/PNG/GIF über `image.DecodeConfig` der Standardbibliothek, WebP/BMP über `x/image`, ICO und AVIF (ISOBMFF `ftyp`/`ispe`, Animationsmarke `avis`) über eigene kleine Parser (ICO-Größe 0 = 256, PNG-Einträge; AVIF `ispe` über `ipma` dem Primärelement zugeordnet, `irot` beachten), Animation bei PNG (`acTL`), GIF (Blockzählung ohne LZW-Dekodierung) und WebP (`VP8X`-Flag). Bekannte Lücken der Go-Decoder (arithmetisch kodierte/12-Bit-JPEG, BMP mit 1/4/16 bpp, RLE, OS/2) brauchen eigene Kopfparser. G05 belegt per Fixturetabelle, dass Go und Pillow dieselben Formate/Abmessungen/Animationen erkennen; der Worker prüft vor dem Dekodieren erneut. Gelingt der Nachweis für ein Format nicht, wird ein isolierter Probe-Kindprozess im Worker ergänzt statt das Format still auszuschließen.

## 6. Cutover und Rückweg (lokal)

Ein Go-Worker liest keine Celery-Nachrichten. Alter und neuer Betrieb laufen nie gleichzeitig auf derselben Datenbank. Kein `FLUSHALL`, kein `docker compose down -v`, keine Volumenlöschung.

1. **Annahme stoppen:** `docker compose stop web api` (Browser erhalten Netzwerkfehler, kein automatischer Neuupload).
2. **Veröffentlichung stoppen:** `docker compose stop dispatcher`.
3. **Laufendes beenden:** Worker bis zu 330 s (PDF-Zeitlimit + Puffer) leerlaufen lassen (`state='running'` zählen); danach `docker compose stop worker cleanup`. Nicht fertige Aufträge behalten ihre Lease und werden nach Ablauf von der Go-Recovery wieder eingereiht oder mit `worker-failed` beendet – nie still gelöscht. `running = 0` ist nur eine Momentaufnahme, weil der Celery-Worker nach dem Dispatcherstopp noch Broker-Rückstände abarbeitet; Schritt 5 erfasst alles, was danach noch `queued` ist.
4. **Schema:** `migrate up` (Go). Bei vorhandenem `alembic_version.version_num = '0003'` (Revisions-IDs heißen `0001`–`0003`) übernimmt `schema_migrations` die Versionen 1–3 als Basis (einmalig unter `pg_advisory_lock`); jeder andere Alembic-Stand wird abgelehnt – dann zuerst mit dem alten Image `alembic upgrade head` ausführen; leere Datenbanken bekommen dieselben Tabellen aus den portierten SQL-Dateien. Weitere Go-Migrationen sind bis G12 ausschließlich additiv und für den Python-Code unschädlich (keine neuen NOT-NULL-Spalten ohne Default, keine neuen Zustände/CHECK-Werte); ein Test hält das fest.
5. **Queue übernehmen:** `migrate requeue` gibt jedem nicht gelöschten `queued`-Auftrag ohne offenen Dispatch-Eintrag genau einen neuen (`published_at IS NULL`). Idempotent, in einer Transaktion. Sitzungen, Besitzer, Idempotenzschlüssel, Ergebnisse und `download_until` bleiben unverändert.
6. **Go starten:** `worker` (Probe), `cleanup`, `api`, `web`.
7. **Legacy-Broker:** Celery-Schlüssel (Queue `celery` laut `app/worker/celery_app.py`, `_kombu.*`, `unacked*`; vor dem Entfernen per `SCAN` mit diesen Mustern konkret auflisten) bleiben in Valkey liegen und werden von Go nie gelesen. Entfernen höchstens gezielt per `DEL` dieser Schlüssel, nachdem Go läuft.

Rückweg **vor** Schritt 4: alte Dienste wieder starten. Rückweg **nach** Go-Betrieb (bis G12, solange nur additive Migrationen existieren): Go-Dienste wie oben stoppen, `migrate requeue` erneut als Sicherheitsnetz (Claim und Recovery sind atomar, ein `queued`-Auftrag ohne offenen Eintrag ist im Go-Betrieb nicht vorgesehen), Python-Dispatcher/Worker/API starten; deren Dispatcher sendet offene Einträge wieder an Celery. Ein Rückweg, der seit dem Cutover angenommene Aufträge verliert, ist ausgeschlossen. G11 probt beide Richtungen mit echten Aufträgen.

## 7. Bewusst nicht Teil der Migration

Keine Änderung der Bild-/PDF-Algorithmen, keine neuen Formate, kein S3, kein öffentlicher Betrieb, kein Frontend-Redesign. Leistungsaussagen nur mit Messung (G11).

## Implementierungshinweise nach G09

- Prospektive Job-ID und Uploadreservierungs-ID sind identisch. Dadurch kann Cleanup eine nach Dateipromotion, aber vor eindeutig bestätigtem DB-Commit hinterlassene Datei sicher zuordnen. Bei unklarer Commitantwort wird unter einer Transaktionssperre unabhängig nachgeprüft; ist auch das nicht eindeutig möglich, bleiben Datei und Budget konservativ erhalten.
- MIME-Header werden vor dem Standard-Multipartparser auf 8 KiB begrenzt. Dateiproben haben begrenzte Leseoperationen und eigenen Context; AVIF-Abmessungen stammen vom Primärelement, nicht von einem beliebigen Thumbnail.
- API-Anfragen haben begrenzte Contexts; Upload-/Download-Deadlines werden nach der Anfrage für wiederverwendete Verbindungen zurückgesetzt.
