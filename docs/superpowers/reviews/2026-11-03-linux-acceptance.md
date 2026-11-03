# Linux- und Fullstack-Abnahme — 03.11.2026

Verantwortung: Arbeitspunkt 2 des freigegebenen Redesignplans. Prüfungen laufen im vorhandenen Checkout auf `redesign/file-workshop`; Basis vor dieser Arbeit: `b19dc635b8b8d294a409fa9f7526737b175b5395`. Dieser Bericht wird um tatsächliche Ergebnisse ergänzt. Keine Veröffentlichung, kein Push und keine Volumenlöschung.

## Docker-Build: reproduzierter Fehler und begrenzte Korrektur

- `docker version --format '{{.Server.Os}}/{{.Server.Arch}} {{.Server.Version}}'`: Exit 0, `linux/amd64 29.8.2`.
- `docker compose -f server/compose.test.yaml up -d --wait db valkey`: Exit 0; beide isolierten Testdienste gesund. Die Datenbank verwendet tmpfs, der Go-Cache ein separates Testvolume.
- Erster Lauf von `docker compose up -d --build --wait`: Exit 1 nach rund fünf Sekunden. BuildKit übertrug für `server/Dockerfile` nur 2 B Kontext; `COPY server` sowie `COPY converter/...` scheiterten mit `not found`.
- Ursache: Die Root-`.dockerignore` schließt zunächst alles aus. Commit `0d35657` entfernte die Ausnahmen für die weiterhin von Compose gebauten Go-/Codec-Verzeichnisse. Die Dateien waren auf dem Host vorhanden, im Buildkontext jedoch ausgeschlossen. Der Fehler entsteht vor Compiler oder Codec-Ausführung.
- Eng begrenzte Korrektur: `server/` und `converter/` wieder zulassen; `.venv`, Python-/Prüfcaches und `.data` weiterhin ausschließen. Die Root-Allowlist bleibt bestehen; das für den Produktbuild nicht erforderliche `api/` wird nicht aufgenommen.
- Derselbe vollständige Compose-Befehl nach der Korrektur: Exit 0. API-, Worker- und Web-Images gebaut, Migration Exit 0; Compose meldete DB/Broker/API/Web gesund und Worker/Cleanup laufend. Das ist der konkrete Rot-/Grün-Nachweis des vorhandenen CI-Buildgates, kein bloßer Textvergleich der Ignoredatei.

Der vorhandene, seit neun Tagen beendete Legacy-Dispatcher wurde als Orphan gemeldet und unverändert belassen. Bestehende Volumes bleiben erhalten. Der ergänzende Imageabgleich und die echten API-Dateidurchläufe sind unten dokumentiert; ein erfolgreicher Build allein belegt diese nicht.

## Linux-Prüfgates und private Codec-Integration

Alle folgenden Befehle wurden tatsächlich ausgeführt; kein Ergebnis wird aus bloßer Quelltextlektüre abgeleitet.

| Befehl | Ergebnis |
| --- | --- |
| `docker compose -f server/compose.test.yaml run --rm go go vet ./...` | Exit 0 |
| `docker compose -f server/compose.test.yaml run --rm go go test -race ./...` | Exit 0; 14 Testpakete bestanden, fünf Pakete ohne Tests; längstes gemeldetes Paket `internal/jobs` 7,070 s |
| `docker compose -f server/compose.test.yaml run --rm go sh -c 'test -z "$(gofmt -l .)"'` | Exit 0; keine Formatabweichung |
| `docker compose -f server/compose.test.yaml run --rm go go run golang.org/x/vuln/cmd/govulncheck@v1.9.0 ./...` | Exit 0, `No vulnerabilities found.` |
| `docker build --target test -t mi-converter-converter-test:local converter` | Exit 0; bestehendes gepinntes Linux-Testimage gebaut |
| `docker run --rm --init --network none mi-converter-converter-test:local` | Exit 0; Python 3.13.17, **181 bestanden, null übersprungen**, 16,12 s; darunter zwölf Sandboxtests |
| `docker run --rm --init --network none -e RUFF_CACHE_DIR=/tmp/ruff -e MYPY_CACHE_DIR=/tmp/mypy mi-converter-converter-test:local sh -c 'ruff check . && ruff format --check . && mypy'` | Exit 0; Ruff bestanden, 27 Dateien formatiert, mypy ohne Befund in 27 Quelldateien |

Die erste zusätzliche Ruff-Ausführung versuchte einen Cache unter `/app` anzulegen und scheiterte an der vorgesehenen Benutzerberechtigung. Nur die Prüfcachepfade wurden daraufhin auf `/tmp` gesetzt; keine Produktberechtigung oder Prüfrichtlinie wurde gelockert. Die Linux-Python-Suite führt die auf Windows übersprungenen Sandbox-/`O_NOFOLLOW`-Fälle aus. Die POSIX-Pfadvalidierung bleibt unverändert; der zuvor beobachtete Windows-Runner-Testfehler trat unter Linux nicht auf. Das belegt den Linux-Vertrag und behauptet keine Windows-Parserunterstützung.

Die Go-Suite erreicht echte isolierte PostgreSQL- und Valkey-Dienste. Erfolgreiche Tests umfassen unter anderem `TestUploadReplayOwnerCancellationAndDelete`, `TestSuccessfulDownloadLeaseHeadersAndExpiry`, `TestWriteRequiresCSRFAndOrigin`, `TestWindowLimit`, `TestConcurrentChecksNeverExceedLimit`, `TestFailClosed`, `TestWorkerCancellationWinsBeforePublication`, `TestConcurrentQueueClaimAndRecoveryReservation`, `TestCleanupRunningExpiryAndDeletionRetainCrashBytes`, `TestCleanupHonorsDownloadLeaseThenDeletes` und `TestRequeueConcurrentRunsInsertOnce`. Workerprozessoren dieser Domänentests sind teilweise kontrollierte Testprozessoren; sie ersetzen den folgenden echten privaten Codec-Aufruf nicht. Ablauf/Cleanup/Recovery wurden in der isolierten Datenbank geprüft, nicht durch Manipulation bestehender Hauptstackdaten oder einstündiges Warten im Browser.

Private Go→Python-Prüfung entsprechend dem CI-Gate, unter PowerShell mit vollständig gequoteten Go-Testargumenten:

```powershell
New-Item -ItemType Directory -Force -Path 'server/.data' | Out-Null
docker compose -f server/compose.test.yaml run --rm go go test -c -o /src/server/.data/converter.test ./internal/converter
$integrationPath = (Resolve-Path -LiteralPath 'server/.data').Path
docker run --rm --init --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --tmpfs /tmp:rw,noexec,nosuid,size=128m --mount "type=bind,source=$integrationPath,target=/integration,readonly" -e CONVERTER_TEST_PYTHON=/opt/venv/bin/python --entrypoint /integration/converter.test mi-converter-go-worker:local '-test.run=^TestRealPython' '-test.v=true' '-test.timeout=90s'
```

Beide Befehle Exit 0. `TestRealPythonImagePipeline` bestand mit den drei Unterfällen Konvertieren, Komprimieren, Skalieren (320×200 → 160×100); `TestRealPythonPDFVariantsAndProbe` bestand mit Codec-Probe, Analyse und drei PDF-Ergebnissen. Gemeldete Laufzeiten: 0,66 s und 0,47 s. Ein erster CLI-Aufruf mit unvollständig gequotetem `-test.v` scheiterte vor Testbeginn an PowerShell-Argumentübergabe; der oben dokumentierte Aufruf ist der tatsächlich bestandene Lauf. Die Sandbox lief ohne Netzwerk, mit schreibgeschütztem Root-Dateisystem, entfernten Capabilities und `no-new-privileges`.

**Offene Review-Abhängigkeit:** Der separate unabhängige Infrastrukturreview meldete nach diesen Läufen einen bestätigten P2-Befund: `ratelimit.NewClient` setzt `MaxRetries: 0`, was go-redis 9.23 auf drei Retries normalisiert; `-1` ist zur tatsächlichen Deaktivierung erforderlich. Die Korrektur und deren Regression liegen beim zuständigen Fixagenten. Die obigen Gates sind der geprüfte Stand vor dieser Korrektur; eine gezielte erneute Linux-Race-Prüfung von `internal/ratelimit` nach deren Integration steht aus. Arbeitspunkt 2 ist damit noch nicht abschließend freigegeben.

## Laufende Images und echte vier Werkzeuge

Der erste Compose-Lauf ließ die bereits vorhandenen Worker-/Webcontainer mit älteren Image-IDs laufen. Deshalb erfolgte vor dem maßgeblichen zweiten Smoke-Lauf ein gezieltes `docker compose up -d --wait --force-recreate worker web` (Exit 0), ohne Daten-/Volumenlöschung. Danach ergab der tatsächliche Abgleich von `docker inspect` mit `docker image inspect` für Container und jeweiliges lokales Image identische IDs:

| Dienst | Image-ID (SHA-256, Präfix) |
| --- | --- |
| API | `796beb97344bcd48` |
| Worker | `527ce92a656734f2` |
| Web | `38b8f216ddd307fc` |

`uv run --project converter python scripts/smoke-stack.py` lief zweimal mit Exit 0; der zweite Lauf erfolgte nach dem obigen Imageabgleich gegen `http://localhost:8080`. Vier echte Aufträge liefen über Nginx, Go-API, PostgreSQL-Queue und privaten Python-Worker:

| Aufgabe | Eingabe und tatsächlich geprüfte Ausgabe |
| --- | --- |
| Konvertieren | RGBA-PNG 160×96 → ein WebP-Ergebnis; heruntergeladen und mit Pillow geöffnet/dekodiert |
| Komprimieren | Dasselbe PNG → ein JPEG-Ergebnis mit Qualität 0,6; heruntergeladen und dekodiert |
| Skalieren | Dasselbe PNG, 50 Prozent → ein PNG-Ergebnis; tatsächliche Maße **80×48** geprüft |
| PDF-Komprimieren | Echte erzeugte PDF mit einer leeren Seite → **drei** Ergebnisse; jede heruntergeladene PDF mit pikepdf geöffnet und auf genau eine Seite geprüft |

Alle vier Aufträge erreichten `succeeded`. Bei allen sechs Downloads entsprach die tatsächliche Bytelänge dem gemeldeten API-Feld `size`, und `Content-Disposition` enthielt `attachment`. Das Smoke-Skript fordert danach für jeden eigenen Auftrag `DELETE` an. Leere PDF-Seiten beweisen Lesbarkeit und den Drei-Varianten-Ablauf; daraus wird keine Bildreduktion oder Einspargarantie abgeleitet. Der Smoke liest und dekodiert die Bilder; die Format-/Dimensionsprüfungen der drei privaten Bildpfade sind zusätzlich im isolierten Go→Python-Gate enthalten.

## Normale Live-Limits und HTTP-Lebenszyklus

Zusätzliche begrenzte Einmalproben gegen `http://127.0.0.1:8080` verwendeten separate Cookiejars, echte PNG-Bytes und nur eigene kurzlebige Aufträge. Bestätigt wurden:

- Sitzungscookie mit `HttpOnly` und `SameSite=strict`.
- Schreibanfrage ohne CSRF-Token: **403**; gültiger Token mit fremdem Origin: **403**.
- Fremde Sitzung kann den real erstellten Auftrag nicht lesen: **404**.
- Sofortiger Abbruch eines angenommenen Auftrags: **200**, `cancellation: completed`.
- Löschen des eigenen Auftrags: **204**; anschließender Statusabruf: **404**.
- Nicht unterstützte Dateisignatur mit ansonsten gültigem Multipart: **415**.
- Reguläres Erstelllimit: **429**, Fehlercode `rate-limited`, deutscher Text `Zu viele Anfragen.`, Header `Retry-After: 60` und gleiches `retryAfterSeconds` im Fehlerobjekt. Die abschließende isolierte Rate-Probe erreichte dies nach zwei begrenzten Versuchen und endete mit Exit 0.

Diese Ergebnisse sind einzelne geprüfte HTTP-Checks. Das erste kombinierte Ad-hoc-Skript lief nicht insgesamt grün: anfängliche Harnessannahmen zu Cookie-Schreibweise und Fehlerhülle wurden an den bestehenden Vertrag angepasst; spätere kombinierte Wiederholungen trafen bereits das bewusst ausgeschöpfte 429-Limit. Es gab daraus keinen Produktpatch und keine stillen Upload-Wiederholungen. Die vollständigen vier Konvertierungsdurchläufe oben sind davon getrennte, erfolgreiche Skriptläufe.

Die tatsächliche API-Containerkonfiguration wurde auf die drei nicht sensitiven Grenzwerte eingeschränkt ausgelesen: `CONVERTER_IP_CREATES_PER_MINUTE=10`, `CONVERTER_SESSION_CREATES_PER_MINUTE=10`, `CONVERTER_SESSION_NEW_PER_MINUTE=30`. Für diese Abnahme wurde kein Limit erhöht. Größere spätere Browsermatrizen dürfen entsprechend dem vorhandenen CI-Workflow diese drei Werte ausdrücklich auf 1000 setzen; das ist eine lokale Testkonfiguration, muss als solche protokolliert und danach zurückgenommen werden.

## Übergabe und verbleibende Abnahme

Hauptstack sowie isolierte Test-DB/Valkey bleiben für nachfolgende UI-Prüfungen laufen. DB/Broker/API/Web waren zuletzt gesund, Worker/Cleanup liefen, Migration endete mit Exit 0. Die Smoke-Webversion ist die vor der parallelen Gestaltung gebaute Version; der finale Redesignbuild und dessen Browsermatrix gehören zur abschließenden Abnahme. Ablauf, Cleanup, Downloadleases und Recovery wurden in echten isolierten PostgreSQL-/Valkey-Tests geprüft; im Hauptstack wurden keine bestehenden Datensätze manipuliert und kein absichtlicher Abhängigkeitsausfall ausgelöst.

Noch offen sind die Integration des unabhängig bestätigten Valkey-Retryfixes mit gezieltem Linux-Race-Nachweis, die Abschlussentscheidung des unabhängigen Infrastrukturreviews und die finale Browser-/Redesignmatrix. GitHub Actions wurde lokal nicht als ausgeführt behauptet; ein späterer Push oder eine Veröffentlichung ist nicht erfolgt.
