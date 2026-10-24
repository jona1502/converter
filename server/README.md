# Go-Backend

Start im Projektstamm: `docker compose up -d --build --wait`.

`cmd/api`, `cmd/worker`, `cmd/cleanup` und `cmd/migrate` sind getrennte Go-Befehle. HTTP nutzt die Standardbibliothek, PostgreSQL speichert Aufträge und Queue, Valkey begrenzt Anfragen. Python läuft ausschließlich als privater Konvertierungsprozess.

Tests ohne lokale Go-Installation:

```sh
docker compose -f server/compose.test.yaml up -d --wait db valkey
docker compose -f server/compose.test.yaml run --rm go go vet ./...
docker compose -f server/compose.test.yaml run --rm go go test -race ./...
```

Betrieb und Rückweg: [Anleitung](../docs/go-backend/operations.md). Architektur und Prüfnachweise liegen ebenfalls unter `docs/go-backend`.
