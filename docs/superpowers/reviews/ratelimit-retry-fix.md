# Valkey-Command-Retries: Korrektur und Nachweis

Datum: 03.11.2026. Bezug: P2 aus dem [unabhängigen Infrastrukturreview](2026-11-03-infrastructure-review.md). Basis: `384977cae5e730b49fcba618d0832837280a1e8f`; Fix mit Regression: `eeb9fe9883f2cf8188b7c7b15a61c1460a4602ad`.

## Ursache und begrenzte Änderung

Die lokal gepinnte Abhängigkeit `github.com/redis/go-redis/v9 v9.23.0` dokumentiert in `options.go:116–120` den Wert `-1` zum Deaktivieren der Command-Retries. Ihre Initialisierung normalisiert `-1` zu effektiv `0`, dagegen Eingabe `0` zu `3` (`options.go:764–768`). Der Command-Ausführungspfad iteriert einschließlich dieser Obergrenze (`redis.go:1576–1597`). Diese Stellen wurden im Modulcache des vorhandenen Compose-Testcontainers gelesen.

`NewClient` setzt jetzt ausschließlich `opts.MaxRetries = -1`. Die bestehenden Kommentare, URL-Fehlerbehandlung und Dial-/Read-/Write-Timeouts von jeweils zwei Sekunden bleiben erhalten. Es gibt keine neue Retryabstraktion und keine Änderung der Quoten-, Fenster- oder Sperrlogik.

## Regression: beobachteter Rot-/Grünlauf

`TestNewClientDisablesCommandRetries` konstruiert den echten Client ohne Command oder Netzwerkzugriff und prüft die bereits durch go-redis normalisierte effektive Option. Der Literal-Erwartungswert ist null Command-Retries. Ein Rückfall auf die bisherige Eingabe `0` wird damit erkannt, ohne erreichbaren Server oder Timingannahme.

Ausgeführt mit dem unveränderten gepinnten Go-Image und der Konfiguration aus `server/compose.test.yaml`:

```text
docker compose -f server/compose.test.yaml run --rm --no-deps go go test -count=1 -run '^TestNewClientDisablesCommandRetries$' -v ./internal/ratelimit
```

- Vor dem Produktivfix: Exit 1, `effektive Command-Retries = 3, erwartet 0` (0,006 s).
- Nach dem Einzeilenfix: Exit 0, derselbe Test PASS (0,006 s).

Test und Fix wurden gemeinsam committet; es gibt keinen absichtlich roten Zwischencommit.

## Paketprüfung mit Race Detector und echtem Valkey

```text
docker compose -f server/compose.test.yaml run --rm go go test -race -count=1 -v ./internal/ratelimit
```

Ergebnis: Exit 0, **9 Tests PASS**, Paketlauf **1,873 s**, keine übersprungenen Tests und kein Racebefund. Die bestehende Compose-Konfiguration setzt `CONVERTER_TEST_REDIS_URL=redis://valkey:6379/15`; die Integrationstests verwenden den echten isolierten Test-Valkey, prüfen DB 15 und räumen nur ihren zufälligen Schlüsselraum auf. Fenstergrenzen, atomare Mehrfachlimits, konkurrierende Prüfungen, Sperrbesitz und ReplayGuard bestanden zusammen mit der neuen Regression.

Der vorhandene `TestFailClosed` bestand ebenfalls (0,81 s). Er deckt fehlenden Client, `ErrUnavailable` bei `Check` und `Acquire` gegen einen verweigernden Port, Geheimnisfreiheit des Check-Fehlers und ungültige URL ab. Es wurde kein redundanter Ausfalltest hinzugefügt. `git diff --check` war vor dem Fixcommit unauffällig.

## Aussagegrenze des Ausfallnachweises

Die erwarteten go-redis-Ausfallmeldungen lauteten zweimal `connection pool: failed to dial after 5 attempts: dial tcp 127.0.0.1:1: connect: connection refused`. Separate Verbindungsversuche des Pools bestehen also weiterhin. Der Fix deaktiviert **Command-Retries**, nicht sämtliche Dialversuche. Weder der Regressionstest noch der verweigernde Port beweisen ein Gesamtlimit von zwei Sekunden bei beliebigen Netzwerkstörungen; die 0,81 s sind beobachtete Laufzeit dieses Tests, keine neue zugesicherte Zeitgrenze.

Die terminalen Fehler bleiben fail-closed. Kein Fail-open oder Quoten-Bypass war nachgewiesen oder Bestandteil dieser Korrektur. Der bestätigte P2 zur Command-Retry-Konfiguration ist mit dieser Regression und Paketprüfung behoben; weitergehende Infrastruktur- und Releaseaussagen bleiben bei den eigenständigen Abnahmeberichten.
