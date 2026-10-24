# Commit-Log – FastAPI-Backend

Ein Eintrag je Arbeitspunkt aus [../fastapi-backend-plan.md](../fastapi-backend-plan.md), Abschnitt 7. Neueste Einträge oben. Hashes stehen nur in der Git-Historie.

## D01 – vorhandenen Designstand sichern

- **Änderungen:** Bereits vor Übernahme vorhandene Umbenennung in MI converter, neue Gestaltung, Dark Mode, Navigation und Footer getrennt vom Backend gesichert.
- **Review:** Unabhängiger Agent `frontend_review`; keine bestätigten Regressionen, keine Nachbearbeitung erforderlich.
- **Prüfung:** Astro-Check ohne Befunde; Produktionsbuild erfolgreich; 92 E2E bestanden, vier geräteabhängig übersprungen. Zusätzliche Dark-Mode-axe-/Überlaufprüfung auf sechs Seiten bei 390 px ohne Befund.
- **Grenze:** Dies ist die bestehende lokale Oberfläche; Servermigration folgt in B10/B11.

## B03

- **Änderungen:** PostgreSQL-Modelle und Alembic-Migration, anonyme Besitzer mit Cookie/CSRF, validierte Auftragsoptionen, begrenzter Multipart-Stream, Header-/Dimensionsprobe, private Dateien, transaktionale Auftragsannahme mit Outbox und Idempotenz, Status und logisches Löschen. Abhängigkeiten für Verarbeitung/Worker bereits reproduzierbar gesperrt.
- **Review:** Autor `backend_b03`, Tests `tests_b03`, unabhängiges Review `frontend_review`; Verzeichnis-fsync-Befund behoben und nachgeprüft. Zusätzlich gecachten CSRF-Schlüssel, Uploadkörpergrenzen und Bereinigung bei Fehler nach Rename korrigiert.
- **Prüfung:** B03-/Basistests gegen dedizierte PostgreSQL-Testdatenbank: 107 bestanden, ein POSIX-Rechtetest unter Windows übersprungen. Scoped Ruff/mypy wurden von Autoren ausgeführt; OpenAPI aktualisiert. Keine Produktdatenbank für Tests zurückgesetzt.
- **Grenzen:** Dispatcher/Worker folgen B04, Konvertierung/Download B05–B08, Rate-/Aktivquoten und physisches Cleanup B09. Keine fertige Serverkonvertierung mit B03 behauptet.

## B04

- **Änderungen:** Wiederholbare Outbox-Veröffentlichung, atomare Claims, Lease/Heartbeat, Recovery mit begrenzten Versuchen, Abbruch, sequenzielle Kindprozessereignisse, feste Ressourcenlimits und Linux-Seccomp-Netzwerksperre. Ergebnisdateien werden vor Veröffentlichung synchronisiert und pro Lease getrennt.
- **Review:** Unabhängig durch `backend_b03`; behoben: fremde/abgelaufene Lease beim Abschluss, SQLAlchemy-Autoflush im Recovery, Erhalt bereits fertiger PDF-Varianten, Reader-Thread-Aufräumen und Ergebnis-fsync.
- **Prüfung:** Acht Runtime-/Prozesstests gegen PostgreSQL bestanden (doppelte Zustellung, konkurrierende Claims, Brokerfehler, Recovery, Cancel/Delete, Timeout). Der echte Bildprozess wurde separat geprüft und sein Test B05 zugeordnet. Ruff scoped grün. Linux-Containerprobe: Socket-Erstellung nach Isolation scheitert mit EPERM. Typprüfung der B04-Dateien grün; parallel in Arbeit befindliche B09-Dateien separat.
- **Grenze:** Volle PDF-Arbeitsreserve (maximal 300 MB statt 100 MB je gleichzeitig bearbeiteter Variante) wird zunächst gemeinsam reserviert. Dies reduziert die Parallelität, vereinfacht aber die harte gemeinsame Budgeteinhaltung. Konvertierungsmodule/API folgen in eigenen Arbeitspunkten.

## B05

- **Änderungen:** Pillow-Serverpipeline für JPEG/PNG/WebP/BMP/ICO mit allen vereinbarten Eingaben, EXIF-Orientierung, explizitem Alpha-Handling, ICO-Einpassen und begrenztem Writer; gemeinsame Verarbeitungsfehler. Capabilities aus echten Codec-Rundreisen, Besitzergebundene Downloads mit endlicher DB-Lease und sicherer Dateinamenkodierung, Cancel-Endpunkt, Migration für Download-Lease.
- **Review:** Bildkern unabhängig von `tests_b03`, API/Download durch `backend_b03`; keine verbleibenden Blocker. Dateihandle erst nach Leasecommit öffnen und per Response-BackgroundTask schließen.
- **Prüfung:** Echter Kindprozess mit gültigem Bilddownload, Größe, Headern, Besitzerbindung und Ablauf geprüft. Health mit fehlendem Pflichtcodec liefert 503. Gesamter Stack über HTTP-Smoke für alle vier Operationen erfolgreich, einschließlich drei PDF-Downloads.
- **Hinweis:** Die gemeinsame Pipeline enthält bereits die Resize-/Kompressionsprimitive; deren vollständige Verhaltensmatrix und Abnahme folgen B06.

## B06

- **Änderungen:** Bildkomprimierung/-skalierung anhand einer vollständigen semantischen Matrix abgesichert: alle Eingaben/Ausgaben, Prozent/Zielmaße, JS-kompatible Rundung, kein unbeabsichtigtes Upscaling, EXIF, ICC→sRGB, Transparenz, ICO-Einträge und begrenzte Ausgabe.
- **Review:** Unabhängig durch `tests_b03`; keine blockierenden Befunde. Der native JPEG-Dateideskriptor-Bypass wurde durch einen begrenzten Writer ohne freigegebenen `fileno` verhindert.
- **Prüfung:** 52 Bildtests bestanden; JPEG/WebP-Qualität beeinflusst echte Größen, PNG bleibt bei geändertem Qualitätswert bytegleich. Gemeinsame Pipeline bereits in B05 eingeführt, dieser Commit ergänzt die vollständige Operationsabnahme.

## B07

- **Änderungen:** pikepdf/Pillow-Kern mit striktem Öffnen, Verschlüsselungsablehnung, rekursiver Platzierungsanalyse, konservativer Bildstream-Ersetzung, verlustfreier Streamoptimierung und begrenztem Ergebniswriter. Unbekannte Platzierungen werden ausdrücklich gemeldet.
- **Review:** Unabhängig durch `backend_b03` und Hauptagent; Fehlercode `save-failed` in den gemeinsamen Antwortvertrag aufgenommen. Zählung neu komprimierter Streams dekodiert fremde Flate-Streams nur begrenzt.
- **Prüfung:** Acht PDF-Kerntests bestanden: drei Stufen, gemeinsame Bilder/größte Platzierung, nichtkommutative Formtransformation, Zyklen, PNG-Predictor, Masken, Verschlüsselung, Limits, Text/Formular/Link/Outline/Seitengeometrie und unabhängiges PDFium-Rendering.
- **Grenzen:** Keine Rasterung ganzer Seiten, keine OCR/Font-Untermenge, unsichere Bilder unverändert; reale signierte/PDF-A-Dokumente sind keine garantierte Erhaltungsklasse.

## B08

- **Änderungen:** Die sequenzielle PDF-Variantenverarbeitung des Workerprotokolls mit dem Produktkern integriert und durch echten Upload→Kindprozess→drei geschützte Downloads abgesichert. Analyse und Variantenmetadaten entsprechen dem API-Vertrag; jede Variante beginnt beim Original.
- **Review:** `backend_b03` prüfte PDF-Kern und API/Download, Hauptagent den kompletten Stack.
- **Prüfung:** Echter PDF-Integrationstest prüft alle drei Varianten mit pikepdf, Seitenzahl, Formularfeld und Annotation. Separater HTTP-Smoke über Proxy/Dispatcher/Celery erfolgreich. Recovery-/Teilresultat-Erhalt ist zusätzlich in B04-Tests abgedeckt.

## B02

- **Commit-Nachricht:** `feat(backend): B02 FastAPI-Grundlage und Prüfwerkzeuge ergänzen`
- **Änderungen:** uv-Projekt `backend/` (Python 3.13, `uv.lock` mit `exclude-newer` 2026-10-17 als 7-Tage-Karenz). App-Factory, Settings mit Präfix `CONVERTER_` (Production verlangt Secret ≥ 32 Zeichen, Secure-Cookie, Origins; Eingabewerte in Validierungsfehlern verborgen, `SecretStr`). Fehlerformat laut Vertrag inklusive 404/405/422/500/503, begrenzte `fields`, Middleware für Request-Id, `no-store` und `nosniff`. JSON-Logs über eine Allowlist ohne Body, Header und Ausnahmetexte. Health live/ready mit Check-Register, Timeout und höchstens einem hängenden Thread je Check, Storage-Check. Export von `openapi.json` mit Drift-Test; `.gitattributes` erzwingt LF für alle Textdateien. Ruff, mypy strict, pytest. Dockerfile mit Digest-Pins, Non-Root (10001), ohne Dev-Abhängigkeiten, Proxy-Header nur mit `CONVERTER_TRUSTED_PROXIES`. API-Titel „MI converter API“.
- **Prüfung:** Autor war der Backend/Jobs-Agent, das Review machte ein unabhängiger Review-Agent in zwei Runden.
  - Befund Hoch: Settings-Fehler gaben den Secret-Anfang und das DB-Passwort im Startlog aus. Behoben und mit Repro bestätigt (0 Treffer).
  - Befunde Mittel: hängende Readiness-Checks konnten den Threadpool erschöpfen; Lieferketten-Alter der Versionen (1–6 Tage). Beides behoben.
  - Niedrige Befunde behoben (Pfadbegrenzung, 5xx-Zuordnung, Exception-Logs, schlankeres Image, Allowlist in `.dockerignore`). Offen und bewusst: OpenAPI-Routen erscheinen im Log als `unmatched`.
- **Checks:** `uv lock --check` (35 Pakete), `ruff check`, `ruff format --check`, `mypy` (strict, 31 Dateien) und `export_openapi.py --check`, alle mit Exit 0. `pytest` 62 bestanden, 1 übersprungen (POSIX-chmod-Test unter Windows), vom Reviewer und vom Hauptagenten wiederholt. Docker-Build und Container: live/ready 200, Status `healthy`, `/docs` in Production 404, Cookie und Query nicht im Log.
- **Einschränkungen:** Ready prüft bisher nur Storage; Datenbank, Redis und Capabilities folgen in B03–B05. fastapi ist wegen der Karenz 0.143.3 statt der neuesten 0.162.0. Ohne Ausnahmetexte in Logs ist die Diagnose bewusst schwerer.

## B01

- **Commit-Nachricht:** `docs(backend): B01 Architektur und API-Vertrag festlegen`
- **Änderungen:** Backend-Plan aufgenommen. API-Vertrag `api-contract.md`: Endpunkte, Fehlercodes, anonyme Sitzung mit HMAC-CSRF-Token und Origin-Prüfung, Zustände von Aufträgen und Ergebnissen, Limits, Idempotenz und Replay ohne Spoolen, atomare Upload-Reservierung, Lease-Token, Speicherschlüssel je Versuch, Recovery über die Outbox, Gewinnerregel bei Abbruch, schrittweises Speicherbudget, Download-Header, Frontend-Regeln und Code-Zuordnung, Logregel für Ausnahmetexte. Wegwerfbarer Machbarkeitsnachweis `feasibility/` (Dockerfile, Bild- und PDF-Skripte, Bericht mit Versionen und Lizenzen). Hinweis in `implementation-plan.md`, welche Regeln für den Serverbetrieb abgelöst sind und welche weiter gelten.
- **Prüfung:** Machbarkeitsnachweis vom Verarbeitungs-Agenten, Vertrag vom Hauptagenten. Unabhängiger Review-Agent in zwei Nachprüfungsrunden: PoC selbst ausgeführt (auch `--no-cache`), eigene Gegenproben (Matrixreihenfolge, kleinste Platzierung, Tiefengrenze).
  - Behobene Befunde zum PoC: DPI-Asserts erkannten eine falsche Matrixreihenfolge bei `cm` bzw. Form-`/Matrix` nicht; jetzt getrennte Gegenproben `POC_SWAP=cm|form`. Außerdem Predictor-Flate, `attempt_recovery=False`, deterministische Fixtures, `minDownscaleFactor`, strengere Asserts, Lizenzangaben.
  - Behobene Befunde zum Vertrag: Ergebnisdateien konkurrierender Worker konnten sich überschreiben; Replay konnte Quoten bzw. Speicherbudget umgehen; Quotenrennen; Spool außerhalb des Budgets; Recovery ohne Outbox und bei angefordertem Abbruch; nicht umsetzbarer Form/UploadFile-Upload.
- **Checks:** `sh docs/backend/feasibility/run.sh` → Exit 0 („BILDER: OK“, „PDF: OK“, beide Gegenproben scheitern wie erwartet), vom Hauptagenten zuletzt erneut ausgeführt. Container-Lauf mit `--network none`, schreibgeschützt, Non-Root. Versionsabfrage auf PyPI und `uv pip compile` aufgelöst.
- **Ergebnis:** Alle Pflichtformate für Bildein- und -ausgabe sind im Image `python:3.13-slim-trixie` mit Pillow 13.0.0 vorhanden. PDF-Optimierung mit pikepdf 10.17.0 und Pillow ist mit Grenzen erfüllbar. DPI aus Platzierungen inklusive Transformationen und Form-XObjects auf konstruierten Fixtures belegt; Strukturerhalt und PDFium-Plausibilitätsrendering (≥ 43 dB PSNR) geprüft. Keine AGPL-Engine.
- **Einschränkungen:** Fixtures sind synthetisch; nicht geprüft wurden reale, signierte und PDF/A-Dokumente, Bilder in Pattern, Type3-Fonts und Appearance-Streams, Scherung sowie Last mit 40 MP bzw. 100 MB. PDFs mit Reparaturbedarf (auch leicht defekter xref) werden abgelehnt. Inline-Images, CMYK, JPX, JBIG2 und Spezialfarbräume bleiben unverändert. Signaturen werden ungültig, PDF/A nicht garantiert. Für das Produkt ist `backend/uv.lock` mit 7 Tagen Karenz maßgeblich, nicht `candidates.in`.
