# FastAPI-Backend – Umsetzungsauftrag für Claude

Stand: 24.10.2026. Dieses Dokument ist ein ausführbarer Arbeitsauftrag, keine bereits erfolgte Umsetzung.

## 1. Auftrag und bestehender Stand

Erweitere die vorhandene deutschsprachige Converter-Website um ein vollwertiges FastAPI-Backend. Die bestehenden vier Werkzeuge sollen Dateien auf dem Server verarbeiten: Bilder konvertieren, komprimieren und skalieren sowie PDFs komprimieren. Arbeite bis zur lokal getesteten, dokumentierten Integration. Verwende ausdrücklich Subagents gemäß Abschnitt 8.

Das Repository enthält Astro/React/TypeScript, einen statischen Build und funktionierende lokale Browserverarbeitung. Einstiegspunkte:

- `src/components/tools/`: Oberflächen, `useImageBatch.ts`, Dateiliste und Optionen.
- `src/lib/image/types.ts`, `limits.ts`, `resize.ts`: bisheriger Bildvertrag und Regeln.
- `src/lib/pdf/`: bisheriger PDF-Vertrag, konservative Optimierung und drei Qualitätsstufen.
- `astro.config.mjs`: bisher `connect-src 'none'`.
- `src/layouts/BaseLayout.astro`, `src/components/site/SiteFooter.astro`, `src/pages/`: Aussagen zur lokalen Verarbeitung.
- `e2e/`, `tests/unit/`: bestehende Prüfungen.

Zuletzt am 24.10.2026 geprüft: Astro-Check ohne Befunde, Build mit sieben Seiten, 410 bestandene Browser-Unit-Tests und zehn übersprungene Fälle, 164 bestandene E2E-Tests und vier geräteabhängig übersprungene Fälle. Diese Zahlen sind eine Ausgangsbasis, keine Vorgabe für neue Testzahlen. `docs/handoff.md` ist ein veralteter, ungetrackter Zwischenstand: nicht als aktuelle Aufgabenliste behandeln und nicht versehentlich stagen.

Dieser Auftrag erweitert die alte reine Browserarchitektur. Die Netzwerkverbote und Architekturentscheidungen im bisherigen `docs/implementation-plan.md` gelten weiter für die lokale Engine, werden aber für den ausdrücklich vorgesehenen Serverbetrieb durch diesen Plan ersetzt. Keine bestehenden Dokumente stillschweigend widersprüchlich lassen.

## 2. Umfang und Produktentscheidungen

- Bestehende vier Werkzeuge und deutsche Bedienoberfläche erhalten.
- Serververarbeitung wird der Standard der integrierten Website. Vor Auswahl/Upload steht deutlich, dass Dateien an den Server übertragen, temporär gespeichert und nach Ablauf gelöscht werden.
- Dateien erst nach ausdrücklichem Klick auf „Konvertieren“, „Komprimieren“ bzw. „Skalieren“ hochladen. Insbesondere PDF-Dateiauswahl darf keinen versteckten Sofortupload auslösen.
- Bestehende lokale Engine während der Migration erhalten und separat testen. In dieser Ausbaustufe keinen zusätzlichen Moduswahlschalter bauen. Kein stiller Rückfall vom Server auf lokale Verarbeitung oder umgekehrt.
- Keine Konten, Abos, Office-/Audio-/Videokonvertierung, OCR oder ZIP-Downloads in diesem Auftrag.
- Lokal vollständiger Betrieb über Docker Compose; keine öffentliche Bereitstellung, kein Push.
- Hosting-/Rechtstexte nicht erfinden. Technische Angaben berichtigen, fehlende Betreiberangaben als offene Veröffentlichungsaufgabe dokumentieren.

## 3. Zielarchitektur

```text
Browser → gleicher Origin /api/v1 → FastAPI → PostgreSQL (Aufträge + Outbox)
                                  ↓
                            privates Dateivolume
                                  ↑
Outbox-Dispatcher → Redis → Celery-Worker → isolierter Konvertierungsprozess
                                  ↓
                            PostgreSQL / Ergebnisse
```

Entscheidungen:

- Python 3.13 als Ausgangspunkt; aktuelle kompatible stabile Abhängigkeiten bei Umsetzung prüfen und reproduzierbar sperren. Frontend mit unterstützter Node-LTS-Version betreiben, nicht einfach die momentan installierte Node-25-Version übernehmen.
- FastAPI, Pydantic, SQLAlchemy 2, Alembic, PostgreSQL.
- Celery mit Redis als Broker; PostgreSQL ist die maßgebliche Quelle für Auftragszustände. Keine rechenintensiven Konvertierungen in FastAPI `BackgroundTasks`, im HTTP-Prozess oder allein in einem flüchtigen In-Memory-Register.
- Pillow für Bilder. pikepdf und Pillow für konservative PDF-Optimierung. Machbarkeit in B01 mit echten Dateien nachweisen; Bildstreams müssen korrekt ersetzt werden, pikepdf ist keine fertige allgemeine Bildkomprimierungsfunktion.
- Keine zusätzliche PDF-Engine oder Lizenz mit neuen Betriebsauflagen ohne dokumentierten Grund einführen. Falls der gewählte Ansatz die PDF-Abnahme nicht erfüllt, konkrete Alternativen und Lizenzfolgen offenlegen, keine leere Erfolgshülle bauen.
- Ein privates gemeinsames Docker-Dateivolume für einen einzelnen Host; austauschbare Storage-Schnittstelle. S3 ist eine spätere Erweiterung.
- Reverse Proxy liefert den Astro-Produktionsbuild und leitet `/api/` an FastAPI. Keine öffentliche Freigabe von PostgreSQL/Redis, kein öffentliches Dateiverzeichnis. Entwicklungszugriff ebenfalls möglichst über denselben Origin.
- API, Worker, Dispatcher, Cleanup, PostgreSQL, Redis und Proxy als getrennte Compose-Dienste. Dispatcher/Cleanup dürfen denselben Backend-Code mit getrennten Einstiegskommandos verwenden.

Vorgeschlagene Struktur:

```text
backend/
  pyproject.toml + Lockdatei
  app/
    api/                # Endpunkte, Autorisierung, Fehlerantworten
    schemas/            # validierte Optionen und Antwortmodelle
    db/                 # Modelle, Transaktionen, Repositories
    jobs/               # Zustandsmaschine, Outbox, Dispatcher, Recovery
    storage/            # private Dateien, atomare Veröffentlichung, Cleanup
    processing/images/  # Pillow-Pipeline
    processing/pdf/     # Analyse und drei Varianten
    worker/             # Celery, Kindprozesse und Limits
    core/               # Konfiguration, Logging, Quoten
  migrations/
  tests/
infra/                  # Proxy- und Containerkonfiguration
compose.yaml
src/lib/api/            # Frontend-Client und Adapter
docs/backend/           # Vertrag, Betrieb, Test- und Reviewbericht
```

## 4. API-Vertrag und Lebenszyklus

Vertrag in B01 festlegen, danach abgestimmt ändern. OpenAPI und TypeScript-Typen synchron halten, vorzugsweise Typen aus OpenAPI generieren und Drift in CI prüfen.

| Endpunkt | Bedeutung |
| --- | --- |
| `GET /api/v1/capabilities` | Tatsächlich installierte Ein-/Ausgabeformate, Werkzeuge und Grenzwerte |
| `POST /api/v1/jobs` | Multipart: eine Datei und streng validierte JSON-Optionen; antwortet `202` nach dauerhafter Annahme |
| `GET /api/v1/jobs/{id}` | Zustand, Phase, echte Zähler, Analyse, Ergebnis-Metadaten, Ablaufzeit |
| `POST /api/v1/jobs/{id}/cancel` | Idempotenter Abbruchwunsch; Antwort unterscheidet angefordert und abgeschlossen |
| `DELETE /api/v1/jobs/{id}` | Zugriff sofort sperren, gegebenenfalls abbrechen, Löschung zuverlässig ausführen |
| `GET /api/v1/jobs/{id}/results/{result_id}` | Autorisierter Download eines fertig veröffentlichten Ergebnisses |
| `GET /api/v1/health/live` und `/ready` | Prozesszustand bzw. benötigte Abhängigkeiten; keine vertraulichen Details |

- Ein Bild = ein Auftrag; vorhandene Stapeloberfläche startet bis zu 30 Einzelaufträge mit begrenzter Uploadparallelität. Eine PDF = ein Auftrag mit drei sequenziell erzeugten Ergebnissen.
- Zustände: `queued`, `running`, `succeeded`, `partially_succeeded`, `failed`, `cancelled`, `expired`. Upload ist ein eigener Frontendzustand; Auftrag wird erst nach vollständiger Annahme sichtbar.
- Ergebniszustände je PDF-Stufe separat. Fertige Varianten dürfen schon heruntergeladen werden, während weitere laufen; spätere Fehler löschen keine früheren gültigen Varianten.
- Bei Statusübergängen Version/Lease prüfen. Ein verspäteter oder doppelter Worker darf abgebrochene/gelöschte Aufträge nicht wiederbeleben.
- Auftrag und Outbox-Eintrag gemeinsam in PostgreSQL committen. Dispatcher veröffentlicht wiederholbar; Worker beansprucht einen Auftrag atomar. Redis-Nachrichten enthalten IDs, keine Dateiinhalte oder Zugriffstokens.
- Worker-Heartbeat und auslaufende Leases ermöglichen kontrollierte Wiederaufnahme nach Prozessabsturz. Begrenzte Versuche; fehlerhafte Dateien oder wiederholte Speicherüberschreitung nicht endlos wiederholen.
- `Idempotency-Key` für Auftragserstellung; Schlüssel an anonymen Besitzer und Payload-Fingerabdruck binden, Wiederholung mit anderer Payload als Konflikt ablehnen. Timeout beim Upload darf bei Wiederholung keine doppelten Konvertierungen erzeugen.
- Einheitliche maschinenlesbare Fehlercodes, deutsche UI-Texte; keine Tracebacks oder internen Pfade an den Browser.
- Polling anfänglich etwa einmal pro Sekunde, Backoff bei Fehlern, anhalten nach Endzustand und bei verlassenem Werkzeug. Keine erfundenen Prozentwerte für unbekannte Verarbeitungsschritte.

### Anonymer Zugriff ohne Benutzerkonto

- Server legt eine zufällige, ausreichend starke anonyme Sitzung an; Secure-/HttpOnly-/SameSite-Cookie im Produktivbetrieb. In der DB nur abgeleitete/gehashte Sitzungskennungen speichern; lokale HTTP-Ausnahme explizit konfigurieren.
- Jeder Status-, Download-, Lösch- und Abbruchzugriff prüft den Sitzungsbesitzer. Eine UUID ist keine Autorisierung. Fremde/nicht vorhandene Aufträge einheitlich behandeln.
- Schreibende Browserzugriffe durch erlaubten Origin und CSRF-Schutz absichern; CORS nicht pauschal öffnen. Downloads funktionieren mit derselben Sitzung über normale Links.
- Sitzungsdauer mindestens so lang wie Auftragsgültigkeit; Ablauf und Verlust des Cookies erklären. Keine Tokens in URLs, Logs oder dauerhaftem Browserstorage.

## 5. Verarbeitung und Grenzen

### Bilder

- Eingabe: statisches JPEG, PNG, WebP, GIF, BMP, ICO und AVIF, soweit im Container tatsächlich unterstützt. Ausgabe: JPEG, PNG, WebP, BMP, ICO. Fehlende Pflichtformate im ausgelieferten Container sind ein Abnahmefehler; Fähigkeiten auch durch Testdateien prüfen.
- Dateityp anhand der Bytes prüfen, Header prüfen, vor vollständigem Dekodieren Dimensionen begrenzen. Animierte Dateien einschließlich animiertem PNG/WebP/AVIF ablehnen.
- EXIF-Orientierung anwenden; Transparenz und Hintergrundfarbe korrekt behandeln. ICO-Größen 16–256 px wie bisher, quadratisches Einpassen; BMP ohne Alpha mit Hintergrundfüllung. Größten geeigneten ICO-Eintrag einlesen.
- Komprimierung mit ehrlichen formatabhängigen Optionen: Qualität für JPEG/WebP; PNG nur verlustfreie Optimierung und/oder Verkleinerung, keine wirkungslose Qualitätsanzeige.
- Skalierungsregeln erhalten: Prozent oder Zielmaße, Seitenverhältnis standardmäßig an, Vergrößerung nur explizit. „Wie Original“ bei nicht erzeugbarem Format verständlich ablehnen.
- Maximale Eingabe 52.428.800 Bytes, 40 Megapixel und 16.384 Pixel pro Kante; maximal 104.857.600 Bytes je Bildausgabe. Alle Limits sowohl API- als auch Worker-seitig prüfen.
- Ergebnisse werden sich von Browser-Encodern unterscheiden dürfen. Vergleiche Dimensionen, Formate, Orientierung, Transparenz und Qualität, nicht Byteidentität oder gleiche Qualitätszahlen verschiedener Encoder.

### PDF

- Maximal 100.000.000 Bytes Eingabe, maximal 300.000.000 Bytes über alle drei Ergebnisse; maximal 40 Megapixel pro neu kodiertem Bild.
- Signatur/Header und Verschlüsselung prüfen, beschädigte oder verschlüsselte Dokumente verständlich ablehnen.
- Drei Stufen wie bisher: high 300 DPI / 3600 px / Qualität 0,85; balanced 150 DPI / 2000 px / 0,72; small 100 DPI / 1300 px / 0,55. Zahlen sind Ziele, keine garantierte Ausgabequalität. Übersetzung auf Pillow-Qualität dokumentieren.
- Effektive DPI aus Darstellungsgrößen einschließlich Transformationen und Form-XObjects bestimmen; mehrfach verwendete Bilder anhand der größten Platzierung behandeln. Wenn nicht sicher bestimmbar, Pixelgrenze verwenden und diese Einschränkung melden, keine pauschale DPI-Erfüllung behaupten.
- Zunächst sichere RGB-/Graustufen-JPEG- und 8-bit-Flate-Bildstreams neu kodieren; Masken, Spezialfarbräume und unsicher unterstützte Filter unverändert lassen. Gemeinsame Objekte dedupliziert bearbeiten; Rekursion und Zyklen begrenzen.
- Bildstream nur bei sinnvoller tatsächlicher Einsparung ersetzen (bisher mindestens 3 %). PDF-Struktur verlustfrei optimieren, keine Rasterung vollständiger Seiten.
- Text, Vektoren, Links, Lesezeichen, Formulare, Annotationen und Seitengeometrie erhalten und mit gezielten Fixtures prüfen. Digitale Signaturen können ungültig werden; PDF/A-Erhalt nicht garantieren und keine falschen Konformitätskennzeichen erzeugen.
- Tatsächliche Größen messen; größere Ergebnisse und fehlende Einsparungen offen anzeigen. Drei Varianten müssen nicht bei jedem Dokument unterschiedlich groß sein.

### Betrieb und Missbrauchsgrenzen

- Startwerte, konfigurierbar: Auftragsgültigkeit eine Stunde ab Annahme, maximal drei aktive Aufträge je Sitzung, globale Annahmegrenze 50 aktive Aufträge, zehn Erstellungen pro Minute je Sitzung und zusätzlich vertrauenswürdig ermittelter IP. Überschreitungen liefern `429`/`503` mit brauchbarem Retry-Hinweis.
- Frontend wartet bei Stapeln auf verfügbare Plätze, statt alle 30 Dateien zugleich hochzuladen. Rate Limits über mehrere API-Prozesse hinweg durchsetzen; Proxy-Header nur von konfigurierten Proxies akzeptieren.
- Upload tatsächlich streamend begrenzen, auch ohne/mit falschem Content-Length. Proxy-Limit inklusive Multipart-Overhead setzen. Abgebrochene Multipart- und Spool-Dateien ebenfalls entfernen.
- Kein Benutzerpfad im Storage: zufällige interne IDs, private Rechte, atomare Dateien. Originalname nur bereinigt für Anzeige/Download; kein Inhalt/Name in Standardlogs.
- Anfangs ein Konvertierungsprozess pro Worker. Prozesszeitlimit: 120 Sekunden Bild, 300 Sekunden PDF gesamt; konfigurierbar und mit Tests belegen.
- Container mit begrenzter CPU/RAM, ohne root und ohne Docker-Socket, privatem temporären Verzeichnis. Konvertierung ohne ausgehenden Internetzugriff; API und Celery brauchen separat die jeweiligen internen Dienste. Die tatsächliche Netzwerkisolation testen, nicht nur dokumentieren.
- Kindprozess für native Parser/Encoder verwenden und bei Abbruch/Timeout terminieren und einsammeln. Container-RAM-Limit schützt den gesamten Worker, ersetzt keine Behandlung von Worker-Abstürzen.
- Globales Dateispeicherbudget zunächst 5 GB mit Reservierungen für aktive Jobs; freien Speicher und Ergebnisbudgets während des Schreibens prüfen. Quoten und Outbox-Fehler dürfen keine verwaisten Dateien verursachen.
- Cleanup mindestens minütlich, auch nach Neustart: abgelaufene Jobs, Uploadreste, temporäre Ergebnisse und verwaiste Dateien. Mit Worker-Leases/Download-Leases koordinieren; neue Downloads nach Ablauf sperren, aktive Downloads zeitlich begrenzen. TTL bezeichnet logische Sperre; physische Löschung innerhalb des dokumentierten Cleanup-Fensters, keine falschen sofortigen Löschversprechen.
- Volumes mit Nutzerdateien nicht in automatische Backups aufnehmen. Erforderliche DB-Metadaten ebenfalls bereinigen; keine langfristige Historie mit Dateinamen anlegen.

## 6. Frontendmigration

- `src/lib/api/` als gemeinsamen Client und Serveradapter einführen; Upload/Status/Abbruch/Löschung/Download nicht in vier Komponenten duplizieren.
- Bild- und PDF-UI erhalten ihre Bedienregeln, zeigen aber Upload- und Serverzustände. Optionen eines gestarteten Auftrags als Snapshot behandeln.
- Datei entfernen/Reset: laufenden Upload abbrechen; angenommene Serverjobs explizit abbrechen/löschen. Bei Verlassen der Seite keine zuverlässige Löschung versprechen, TTL ist die Rückfallebene.
- Netzwerkabbrüche, `413`, `422`, `429`, `503`, Ablauf und verlorene Sitzung verständlich behandeln. Ergebnisse bleiben während ihrer Gültigkeit erreichbar; keine automatische Neuübertragung ohne Nutzeraktion.
- Alle lokalen Verarbeitungsbehauptungen auf Startseite, Werkzeugseiten, Header/Footer, Erklärseite, Meta-Beschreibungen und README suchen und berichtigen. Erklärseite darf unter bestehender URL weiterleiten oder den neuen Ablauf erklären; interne Links und 404-Verhalten prüfen.
- CSP im Serverbuild minimal auf gleichen Origin öffnen (`connect-src 'self'`); übrige Einschränkungen erhalten, HTTP-Header und Astro-Meta-CSP dürfen sich nicht widersprechen. Bei bewusst lokalem Alt-Testharness dürfen Uploads weiterhin verboten sein.
- Datenschutztests in lokale Engine und Serverablauf aufteilen: lokale Tests behalten das Netzwerkverbot; Server-E2E erwarten gezielt Uploads nur zum eigenen Origin und prüfen unzulässige Fremdanfragen weiterhin.
- Deutsche Größenformatierung und sichtbare Warnungen bei größeren Ergebnissen erhalten. Fokus, Tastatur, mobile Ansichten und axe nach erfolgreicher Verarbeitung erneut prüfen.

## 7. Geplante Commits

Genau ein gezielt gestagter Implementierungscommit pro Arbeitspunkt. Jeder Commit enthält einen Eintrag in `docs/backend/commit-log.md`: ID, konkrete Änderungen, Reviewer, ausgeführte Prüfungen, Ergebnis und verbleibende Grenzen; keinen eigenen Hash in den Eintrag schreiben. Bereits vorhandene Dokumentationsänderungen des Nutzers respektieren. Abhängigkeiten nicht durch ungetestete Sammelcommits überspringen.

| ID | Commit-Nachricht | Inhalt und Abnahme | Abhängigkeit |
| --- | --- | --- | --- |
| B01 | `docs(backend): B01 Architektur und API-Vertrag festlegen` | Plan/Vertrag, Zustände, Limits, Scope; kleiner wegwerfbarer Bild-/PDF-Machbarkeitsnachweis und Bericht inkl. Bibliotheks-/Lizenzprüfung; keine fingierte DPI- oder Struktur-Erhaltung | – |
| B02 | `feat(backend): B02 FastAPI-Grundlage und Prüfwerkzeuge ergänzen` | Projektstruktur, gesperrte Abhängigkeiten, Konfiguration, Health-Endpunkte, Fehlerformat, Ruff, Typprüfung, pytest; minimale startbare Containerbasis | B01 |
| B03 | `feat(storage): B03 Aufträge Sitzungen und Dateispeicher ergänzen` | Migrationen, Modelle, anonyme Besitzer, Storage, streamend begrenzter Upload, idempotente Annahme mit Outbox; fremder Zugriff und Teilupload getestet | B02 |
| B04 | `feat(jobs): B04 Warteschlange Worker und Recovery ergänzen` | Celery/Redis, Dispatcher, Leases, deduplizierte Verarbeitung, Prozesslimits, Abbruch, Status, Wiederanlauf; interne Testverarbeitung statt veröffentlichter Dummy-Konvertierung | B03 |
| B05 | `feat(images): B05 serverseitige Bildkonvertierung ergänzen` | Pillow-Konvertierung aller vereinbarten Formate, Optionen, Capabilities, sichere Downloads; echter Upload→Job→Download-Integrationstest | B04 |
| B06 | `feat(images): B06 Komprimierung und Skalierung ergänzen` | Qualitäts-/Größenregeln, Originalformat, Transparenz und Vergrößerung; semantische Grenz- und Regressionstests | B05 |
| B07 | `feat(pdf): B07 PDF-Analyse und konservative Optimierung ergänzen` | Parser, Analyse, Verschlüsselungsfehler, sichere Bildstream-Neukodierung, Platzierungen und Strukturerhaltung; Kern mit echten Fixtures getestet | B04 |
| B08 | `feat(pdf): B08 drei PDF-Varianten im Auftragsablauf ergänzen` | Drei sequenzielle Resultate, Teilfehler, echte Fortschrittszähler, Budgets, Downloads, Abbruch | B07 |
| B09 | `feat(lifecycle): B09 Quoten Ablauf und zuverlässige Löschung ergänzen` | Sitzungs-/IP-/globale Grenzen, Storage-Reservierungen, Cleanup, Race-Schutz, Fehlerbereinigung und Neustarttests | B06, B08 |
| B10 | `feat(web): B10 Bildwerkzeuge an FastAPI anbinden` | Gemeinsamer Client, drei Bildwerkzeuge, Stapelscheduling, Upload erst nach Klick, alle globalen Server-/Datenschutzhinweise und CSP; PDF noch ausdrücklich als lokales Werkzeug kennzeichnen | B06, B09 |
| B11 | `feat(web): B11 PDF-Werkzeug auf Serveraufträge umstellen` | Expliziter Start, Analyse/Varianten/Reset, letzte lokalen Produktbehauptungen korrigieren; lokale Engine nur als getesteter Code erhalten | B08, B10 |
| B12 | `build(stack): B12 vollständigen Compose-Betrieb und CI ergänzen` | Proxy, Frontendbuild, alle Dienste, Migration als einmaliger Schritt, Healthchecks, persistente Volumes, Isolation und Ressourcen; CI mit echten Diensten und Installationsanleitung | B09, B11 |
| B13 | `test(backend): B13 Wiederanlauf Sicherheit und Oberflächen prüfen` | Vollständige Matrix aus Abschnitt 9, Integrationsfehler beheben, sinnvolle neue Regressionstests; keine Abschwächung vorhandener Assertions zur Grünfärbung | B12 |
| B14 | `docs(backend): B14 Betrieb und Abschlussreview dokumentieren` | README, Architektur, API, Löschfristen, Grenzen, tatsächliche Testbefunde und Lernpfad; unabhängiges Abschlussreview ohne offene Releaseblocker | B13 |

B06 und B07 dürfen nach B05 bzw. B04 parallel entwickelt werden. B12-Konfiguration darf früher vorbereitet werden; kein früherer API-/Worker-Commit darf deshalb unstartbar oder unprüfbar sein. Zusätzliche bestätigte Probleme als B15+ mit jeweils eigenem Review und Commit bearbeiten. Keine Commits/Pushes nur zur Erzeugung einer perfekten Historie umschreiben.

## 8. Verbindlicher Subagent-Workflow für Claude

Du bist der koordinierende Hauptagent. Nutze mehrere Subagents aktiv, nicht nur für ein Abschlussreview. Lies zuerst die Projektanweisungen und diesen Plan, prüfe Branch/Arbeitsbaum und lege einen neuen Featurebranch an, ohne vorhandene Änderungen zu verlieren. Kein Push, kein Force-Reset, kein pauschales `git add .`.

Rollen, bei maximal drei gleichzeitig arbeitenden Subagents:

1. **Backend/Jobs:** `backend/app/api`, `schemas`, `db`, `jobs`, `storage`, `worker`, Migrationen und zugehörige Tests; B02–B04/B09.
2. **Verarbeitung:** `backend/app/processing` und zugehörige Tests; B05–B08. Nach B01 kann dieser Agent unabhängig am stabilen Vertrag arbeiten.
3. **Frontend/Integration:** `src/lib/api`, `src/components`, Seiten und passende E2E-Tests; B10/B11. Nach B01 Client/Adapter mit Vertragstests vorbereiten; vollständige Anbindung erst mit echter API abnehmen.

Bei freiem Slot zusätzlich oder als Rollenwechsel **Review/Prüfung**: fremde Änderungen lesen, Integrations-/Missbrauchs-/Race-Fälle ausführen. Infrastruktur und gemeinsame Dateien wie Compose, README, Contract und Commitlog gehören dem Hauptagenten, außer ausdrücklich anders zugeteilt.

- Vor jedem Auftrag klare Dateizuständigkeit, Schnittstellen, Abhängigkeiten und Fertigkriterien senden. Gemeinsame Dateien nicht gleichzeitig bearbeiten. Bei nötiger Vertragsänderung erst Hauptagent informieren.
- Verwende isolierte Worktrees, wenn die Umgebung das sicher unterstützt; sonst getrennte Dateibereiche im gemeinsamen Arbeitsbaum. Keine parallelen Git-Mutationen.
- Subagents liefern Änderungen, ausgeführte Tests und Risiken an den Hauptagenten. Nur der Hauptagent integriert, staged gezielt und erstellt Commits.
- **Vor jedem Implementierungscommit muss ein anderer Agent als der Autor die Änderungen reviewen.** Ein Review darf keine bloße Selbstbestätigung sein; Blocker beheben und erneut prüfen. Reviewer und Befund im Commitlog festhalten.
- Reviewkapazität durch Rollenwechsel freimachen, statt alle Slots dauerhaft mit Autoren zu belegen. Hauptagent prüft Integration zusätzlich und berichtet dem Nutzer regelmäßig konkrete Ergebnisse.
- Bei fehlender Subagent-Unterstützung offen sagen, dass die geforderte unabhängige Prüfung nicht durchgeführt werden kann; keine Subagent-Reviews erfinden.
- Keine Deploymentfreigabe oder erneute Zustimmung für gewöhnliche lokale Implementierungsschritte verlangen. Echte fehlende fachliche Angaben oder nicht erfüllbare Anforderungen konkret melden; parallel unabhängige Aufgaben fortsetzen.

## 9. Prüfstrategie und Fertigkriterien

Gezielt je Commit prüfen, am Ende vollständige Matrix. Tests müssen Verhalten und Risiken prüfen, nicht bloß Implementierung spiegeln.

### Backend

- Ruff, statische Typprüfung und pytest; echte PostgreSQL-/Redis-Integration statt SQLite als Ersatz für Transaktions-/Lockingtests.
- Alembic-Migration aus leerer Datenbank und Neustart auf bestehender Datenbank.
- Jede Operation Ende-zu-Ende: Multipart-Upload, dauerhafter Job, echter Worker, gültige Ausgabedatei, Status, Download und Löschung.
- Fremde Sitzung, CSRF, ID-Raten, Pfadmanipulation, bereinigte Downloadnamen, falscher MIME-Typ, beschädigte Dateien, Animationen, Pixelbomben und Upload ohne vertrauenswürdige Längenangabe.
- Idempotenz, doppelte Brokerzustellung, DB-Commit/Broker-Ausfall, Worker-Kill, API-Neustart, Redis-Unterbrechung, begrenzte Wiederholung und verlorene Lease.
- Abbruch während Upload/Queue/Konvertierung; Reset gegen gerade fertig werdendes Resultat; Cleanup gegen laufenden Worker/Download; nach Löschung keine spätere Ergebnisveröffentlichung.
- Speicher-/Zeitlimit, voller Speicher, Ergebnisbudget, Quoten über mehrere Prozesse und tatsächliche Netzwerksperre des Konvertierungsprozesses.
- Bilder mit EXIF, Alpha, gemischten Originalformaten, ICO-Einträgen und Formatfähigkeiten; Ergebnisse erneut öffnen und semantisch prüfen.
- PDFs mit Text, Vektoren, JPEG/Flate, Masken, Spezialfarbräumen, Form-XObjects, geteilten Bildern, Annotationen, Links, Formularen und Signaturen. Seiten/Struktur prüfen und repräsentative Ausgaben mit unabhängigem Renderer vergleichen. Renderer nur als Testabhängigkeit, kein Seitenrasterungsersatz in Produktion.

### Frontend und Gesamtbetrieb

- Bestehende lokale Browser-Unit-Tests weiter ausführen. Bestehende E2E bewusst auf Serverablauf migrieren, nicht löschen oder pauschal deaktivieren.
- Produktionsbuild über Proxy gegen echten Stack in Chromium, Firefox, WebKit und mobilem Chromium. Kein ausschließlich gemockter Abnahmelauf.
- Upload erst bei Start; Stapel, Teilfehler, Reset, Ablauf, Serverausfall, neue Auswahl und echte Downloads prüfen. Keine Fremdhosts oder Nutzerdateien im Browserstorage.
- Tastatur/Fokus, 320-px-Ansichten und axe nach Verarbeitung. PDF hängt im Servermodus nicht mehr von OffscreenCanvas im Browser ab.
- Neuer Entwickler kann nach README mit einem dokumentierten Compose-Start und initialer Migration alle vier Werkzeuge verwenden. Container-Neustart verliert keine angenommenen Jobs stillschweigend.
- Health-/Readiness-Ausfälle sichtbar, Auftrags-ID für Diagnose, Logs ohne Dateiinhalte, Zugriffstokens und sensible Namen. CI führt angemessene Prüfungen automatisiert aus.
- Keine offenen kritischen/hohen bestätigten Reviewbefunde; mittlere Befunde mit konkreter Entscheidung und Grenzen dokumentieren. Öffentlicher Produktivbetrieb bleibt ausstehend, solange Betreibertexte und Hostkonfiguration fehlen.

## 10. Abschlusslieferung und Lernziel

Liefere implementierten Code, vollständige Compose-Konfiguration, Migrationen, Tests, API-Dokumentation, Betriebsanleitung, Commitlog und `docs/backend/release-review.md` mit tatsächlich ausgeführten Befehlen und Ergebnissen. Nicht ausgeführte Prüfungen und Gründe ausdrücklich nennen.

Erkläre im README kurz den Weg einer Datei durch API, Datenbank, Outbox, Queue, Worker und Download. Ergänze einen nachvollziehbaren Request-/Statusablauf und Hinweise zum Debuggen. Der Nutzer lernt FastAPI: verständliche Module und begründete Entscheidungen bevorzugen, keine unnötigen Microservices oder abstrakten Frameworkschichten.

## 11. Offizielle Ausgangsquellen

Bei Umsetzung aktuelle kompatible Versionen und konkrete APIs erneut prüfen:

- FastAPI: https://fastapi.tiangolo.com/tutorial/background-tasks/ — Abgrenzung zu externen Verarbeitungsworkern.
- Celery: https://docs.celeryq.dev/en/stable/userguide/tasks.html — Idempotenz, Acknowledgements, Fehlerfälle und Zeitlimits.
- Pillow: https://pillow.readthedocs.io/en/stable/handbook/image-file-formats.html — Formatfähigkeiten und Optionen.
- pikepdf: https://pikepdf.readthedocs.io/en/latest/topics/images.html — Bildstreams, rekursive Form-XObjects und Einschränkungen.

## Direkt verwendbarer Startprompt

> Setze `docs/fastapi-backend-plan.md` in diesem Repository vollständig um. Lies zuerst die Projektanweisungen und den aktuellen Arbeitsbaum. Nutze ausdrücklich Subagents mit getrennten Zuständigkeiten und unabhängigem Review vor jedem Implementierungscommit. Halte die Arbeitspakete B01–B14, Abhängigkeiten, Commit-Nachrichten und das Commitlog ein. Bewahre vorhandene fremde Änderungen, insbesondere die ungetrackte alte `docs/handoff.md`. Arbeite bis zur getesteten Integration aller vier Werkzeuge mit FastAPI, PostgreSQL, Redis/Celery und Docker Compose. Keine Pushes und keine öffentliche Bereitstellung. Berichte tatsächliche Tests, bestätigte Grenzen und offene Blocker ehrlich. Beginne mit B01 und dem Machbarkeitsnachweis, nicht mit parallelen unkoordinierten Änderungen an allen Dateien.
