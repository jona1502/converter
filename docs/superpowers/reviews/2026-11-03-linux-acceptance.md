# Linux- und Fullstack-Abnahme — 03.11.2026

Verantwortung: Arbeitspunkt 2 des freigegebenen Redesignplans. Prüfungen laufen im vorhandenen Checkout auf `redesign/file-workshop`; Basis vor dieser Arbeit: `b19dc635b8b8d294a409fa9f7526737b175b5395`. Dieser Bericht wird um tatsächliche Ergebnisse ergänzt. Keine Veröffentlichung, kein Push und keine Volumenlöschung.

## Docker-Build: reproduzierter Fehler und begrenzte Korrektur

- `docker version --format '{{.Server.Os}}/{{.Server.Arch}} {{.Server.Version}}'`: Exit 0, `linux/amd64 29.8.2`.
- `docker compose -f server/compose.test.yaml up -d --wait db valkey`: Exit 0; beide isolierten Testdienste gesund. Die Datenbank verwendet tmpfs, der Go-Cache ein separates Testvolume.
- Erster Lauf von `docker compose up -d --build --wait`: Exit 1 nach rund fünf Sekunden. BuildKit übertrug für `server/Dockerfile` nur 2 B Kontext; `COPY server` sowie `COPY converter/...` scheiterten mit `not found`.
- Ursache: Die Root-`.dockerignore` schließt zunächst alles aus. Commit `0d35657` entfernte die Ausnahmen für die weiterhin von Compose gebauten Go-/Codec-Verzeichnisse. Die Dateien waren auf dem Host vorhanden, im Buildkontext jedoch ausgeschlossen. Der Fehler entsteht vor Compiler oder Codec-Ausführung.
- Eng begrenzte Korrektur: `server/` und `converter/` wieder zulassen; `.venv`, Python-/Prüfcaches und `.data` weiterhin ausschließen. Die Root-Allowlist bleibt bestehen; das für den Produktbuild nicht erforderliche `api/` wird nicht aufgenommen.
- Derselbe vollständige Compose-Befehl nach der Korrektur: Exit 0. API-, Worker- und Web-Images gebaut, Migration Exit 0; Compose meldete DB/Broker/API/Web gesund und Worker/Cleanup laufend. Das ist der konkrete Rot-/Grün-Nachweis des vorhandenen CI-Buildgates, kein bloßer Textvergleich der Ignoredatei.

Der vorhandene, seit neun Tagen beendete Legacy-Dispatcher wurde als Orphan gemeldet und unverändert belassen. Bestehende Volumes bleiben erhalten. Ein abschließender Abgleich der tatsächlich laufenden Image-IDs und echte API-Dateidurchläufe stehen noch aus; ein erfolgreicher Build allein belegt diese nicht.

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
