# Go-Betrieb

Standardstart im Projektstamm: `docker compose up -d --build --wait`. Website: http://localhost:8080. Datenvolumes beim Stoppen erhalten.

Go-Tests verwenden die unabhängige Umgebung in `server/compose.test.yaml`: erst `db valkey` starten, danach `run --rm go go vet ./...` und `run --rm go go test -race ./...`.

## Wechsel und Rückweg

Uploads pausieren, laufende Aufträge beenden lassen und Datenbank sichern. Alte und neue Worker niemals gleichzeitig betreiben. Beide Betriebsdateien verwenden dieselben Produktvolumes.

FastAPI nach Go:

```sh
docker compose -f infra/compose.fastapi.yaml stop worker dispatcher
docker compose -f infra/compose.fastapi.yaml stop web api cleanup
docker compose run --rm migrate up
docker compose run --rm migrate requeue
docker compose up -d --build --wait
```

Go nach FastAPI:

```sh
docker compose stop worker
docker compose stop web api cleanup
docker compose -f infra/compose.fastapi.yaml up -d --build --wait
```

Beide Richtungen wurden mit vorhandener Sitzung, wartendem Auftrag, Download und Löschung praktisch geprüft. `scripts/cutover-probe.py` ermöglicht die Wiederholung; private Zustandsdateien bleiben unter dem ignorierten `server/.data`.

Der optionale Vergleichsstack `compose.go.yaml` nutzt Port 8081 und eigene Daten. Standardbetrieb bleibt Port 8080. Größere Browserprüfungen nutzen temporär höhere Ratenlimits; danach normale Compose-Vorgaben wiederherstellen. Keine Brokerdaten pauschal löschen.
