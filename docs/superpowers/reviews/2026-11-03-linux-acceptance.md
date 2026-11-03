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
