# Lokaler Abschluss am 24.10.2026

Go ist der Standardbetrieb auf http://localhost:8080. Alle vier Werkzeuge und die einfache Startseite bleiben erhalten. API, Sitzung, Annahme, PostgreSQL-Queue, Workersteuerung, Recovery und Cleanup sind Go. Pillow/pikepdf bleiben private, isolierte Python-Codecs.

## Nachweise

- Vollständiges Go Vet und Race-Testpaket gegen isolierte PostgreSQL-/Valkey-Dienste bestanden.
- govulncheck v1.9.0: keine gefundenen Schwachstellen zum Prüfzeitpunkt.
- Standalone-Codecs: 181 Linux-Tests bestanden; Ruff, Formatierung und Mypy grün (Konverter-Subagent).
- Echter Go-zu-Python-Lauf im gehärteten Workerimage ohne Netzwerk: drei Bildoperationen sowie PDF-Varianten und Codecprobe bestanden.
- HTTP-Smoke gegen den finalen Standardstack: alle vier Werkzeuge bestanden, Ergebnisse geprüft und gelöscht.
- Finale Browserprüfung gegen Port 8080: 176 bestanden, vier geräteabhängige Fälle übersprungen.
- FastAPI nach Go und zurück mit bestehender Sitzung und wartendem Auftrag praktisch erfolgreich geprüft; Download und Löschung funktionierten nach beiden Wechseln. Anschließend wieder auf Go gestartet. Datenvolumes erhalten.
- Kanonischer API-Typabgleich und Git-Diff-Prüfung bestanden.

Lokale Momentaufnahme: 20 sequenzielle Abfragen nach drei Aufwärmanfragen. Health Median 1,53 ms / p95 2,05 ms, Capabilities 1,34 / 1,59 ms. Docker meldete API 9,246 MiB und Worker 11,05 MiB im Leerlauf. Das ist kein Vergleich der Konvertierungsgeschwindigkeit mit FastAPI.

## Grenzen und Abweichungen

Der alte Quellbaum `backend/` bleibt für den getesteten Rückweg und Schema-Kompatibilitätsprüfungen erhalten; er gehört nicht zum normalen Runtimeimage. Seine physische Entfernung folgt erst nach Ende des Rückwegfensters.

Subagent-Reviews für API, Queue, Speicher und Konverter stehen im Commitlog. Der letzte unabhängige Infrastruktur-Nachreview war wegen des Nutzungslimits nicht verfügbar; der Hauptagent prüfte Infrastruktur und reale Container. Eine vollständige unabhängige Abschlussfreigabe liegt damit nicht vor.

Der neue GitHub-Workflow ist vorbereitet, aber ohne Push nicht auf GitHub ausgeführt. Kein öffentliches Deployment, Produktionslasttest oder externes Sicherheitsaudit. Vor Veröffentlichung müssen die lokalen Entwicklungseinstellungen angepasst werden.
