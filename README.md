# MI converter

Deutschsprachige Astro/React-Website mit Go-Backend für Bildkonvertierung, Komprimierung, Skalierung, PDF-Komprimierung, Markdown zu PDF, PDF zusammenführen und Audiokonvertierung. Die Website verarbeitet Dateien auf dem Server. Ein Upload beginnt erst nach einem ausdrücklichen Klick auf den Verarbeitungsbutton.

## Lokal starten

**Entwicklung:** `npm run dev` baut und startet den Compose-Stack (`npm run stack:up`) und danach Astro dev auf **http://localhost:4321**. Astro leitet `/api` an den Stack auf Port 8080 weiter; Origin `localhost:4321` ist dafür in `compose.yaml` erlaubt. Nur Frontend ohne Stack: `npm run dev:web`. Stack stoppen: `npm run stack:down` (Volumes bleiben), Logs: `npm run stack:logs`.

Voraussetzung: Docker mit Compose und laufender Linux-Container-Engine. Im Projektverzeichnis:

```sh
docker compose up -d --build --wait
```

Website: **http://localhost:8080**. Der Dienst `migrate` führt die Go-Schemamigration aus und endet erfolgreich, bevor API und Worker starten.

```sh
docker compose ps
docker compose logs --tail 50 api worker cleanup
docker compose down
```

`down` erhält die Volumes. Diese enthalten temporäre Dateien bzw. Auftragsmetadaten. Volumes nicht pauschal löschen, um Installationsprobleme zu beheben.

Compose ist für lokalen HTTP-Betrieb konfiguriert: lokale Zugangsdaten, Entwicklungssecret und Cookie ohne Secure. Für öffentliches Hosting sind individuelle Secrets, HTTPS, Secure-Cookies, erlaubte Origins und echte Betreiber-/Datenschutzhinweise erforderlich. Es erfolgt keine automatische Veröffentlichung.

## Architektur und Weg einer Datei

1. Nginx liefert den statischen Astro-Build und leitet `/api/v1/` an die Go-API weiter. Downloads sind keine öffentlichen Dateipfade.
2. Go verwaltet eine anonyme Sitzung mit HttpOnly-Cookie und CSRF-Schutz. Jeder Auftragszugriff prüft den Besitzer.
3. Nach Klick auf den Verarbeitungsbutton werden Optionen und eine Datei streamend geprüft. Auftrag und Outbox werden gemeinsam in PostgreSQL angenommen; Antwort: `202`.
4. Go-Worker beanspruchen die PostgreSQL-Outbox direkt als Queue. PostgreSQL bleibt die Quelle für Status und Wiederanlauf; Valkey verwaltet nur Ratenlimits.
5. Ein Worker beansprucht den Auftrag mit Lease. Ein separater Linux-Prozess verarbeitet ihn ohne Netzwerksockets und DB-/Broker-Secrets, mit Zeit-, Speicher- und Dateigrößenlimits.
6. Fertige Dateien werden synchronisiert und in der Datenbank veröffentlicht. Die Oberfläche fragt den Status ab und bietet autorisierte Downloads an.
7. Cleanup sperrt abgelaufene Aufträge und entfernt Dateien und Metadaten. Download- und alte Worker-Leases werden berücksichtigt.

Ein Bild oder Markdown-Dokument entspricht einem Auftrag mit einem Ergebnis. PDF-Komprimierung erzeugt drei sequenzielle Varianten; fertige Varianten sind bereits während der übrigen Verarbeitung abrufbar.

## Funktionen und Grenzen

- Bilder: statische JPEG/PNG/WebP/GIF/BMP/ICO/AVIF als Eingabe; JPEG, PNG, WebP, BMP und ICO als Ausgabe. Codecs werden mit echten Rundreisen geprüft.
- Komprimierung: Qualität für JPEG/WebP, optional kleinere Abmessungen. PNG wird verlustfrei optimiert; keine wirkungslose Qualitätsanzeige.
- Skalierung: Prozent/Zielmaße, Seitenverhältnis standardmäßig erhalten, Vergrößerung nur ausdrücklich.
- PDF: high/balanced/small mit 300/150/100-DPI-Zielen und zusätzlichen Pixelgrenzen. Jede Variante beginnt beim Original. Keine Rasterung ganzer Seiten, OCR oder Verkleinerung von Schriften. Masken, Spezialfarbräume und unsicher unterstützte Filter bleiben unverändert.
- Markdown zu PDF (`/pdf/markdown`): jeweils eine `.md`- oder `.markdown`-Datei in UTF-8, optional mit BOM. Auswahl und vollständige lokale Textprüfung laden nichts hoch; erst „PDF erstellen“ startet den Serverauftrag. Überschriften, Absätze, Listen, Zitate, Links, Tabellen und Codeblöcke erscheinen als auswählbarer Text. Einstellungen: Seitenformat (`pageSize`: `a4` oder `letter`, Standard `a4`) und Ausrichtung (`orientation`: `portrait` oder `landscape`, Standard `portrait`); unbekannte Werte oder Felder weist die API mit `invalid-options` zurück. Lange Codezeilen und Tabellenzellen werden umgebrochen, Tabellenköpfe wiederholt. Eingebettete lizenzierte Schrift für lateinisches Alphabet und deutsche Umlaute; keine vollständige CJK-/Emoji-Abdeckung. Bilder werden ausschließlich als Alternativtext ausgegeben, ohne Ressourcen zu laden; HTML wird nicht ausgeführt. Aktive Links nur für `https`, `http`, `mailto`. Kein eigenes CSS, JavaScript, Mermaid, LaTeX oder ZIP.
- PDF zusammenführen (`/pdf/zusammenfuehren`): zwei bis zwanzig PDFs, zusammen höchstens `PDF_MAX_INPUT_BYTES` (100.000.000 Bytes). Auswahl, lokale Prüfung (Größe, PDF-Signatur) und Sortieren laden nichts hoch; erst „PDFs zusammenführen“ startet den Serverauftrag. Die Reihenfolge der Liste (Schaltflächen „Nach oben“/„Nach unten“, per Tastatur bedienbar) ist die Reihenfolge im Ergebnis `zusammengefuehrt.pdf`; jede Änderung der Liste verwirft ein vorhandenes Ergebnis und fordert die Löschung des Auftrags an. Seiten werden unverändert übernommen, höchstens 2000 Seiten und `PDF_MAX_INPUT_BYTES` Ergebnis. Verschlüsselte, beschädigte oder nur durch Reparatur lesbare PDFs werden abgelehnt (`encrypted`, `parse-failed`); Lesezeichen, Formularfelder, Dokumenteigenschaften und Signaturen der Quellen werden nicht übernommen, Signaturen werden ungültig. Optionen: nur `{"tool":"pdf-merge"}`, weitere Felder weist die API zurück. Die Dateien werden beim Upload zu einem Bündel in der einen Eingabedatei des Auftrags zusammengefasst; Details: `docs/superpowers/specs/2026-11-18-pdf-merge-design.md`.
- Audio: MP3, WAV, FLAC und OGG (Vorbis/Opus) als Eingabe; MP3, WAV, FLAC und Ogg Vorbis als Ausgabe (soundfile/libsndfile aus dem Wheel, kein ffmpeg). Qualität wirkt nur bei MP3/OGG, optional Mono-Downmix. Abtastrate bleibt erhalten; MP3 nur bis 48 kHz und höchstens zwei Kanäle. Tags und Cover werden nicht übernommen. Kein M4A/AAC.
- Stapel-ZIP: Sind nach einem Durchlauf mindestens zwei Audiodateien fertig, lädt „Alle als ZIP speichern“ deren Ergebnisse als `ergebnisse.zip` (`GET /api/v1/jobs/archive?job_id=…`, höchstens 30 Aufträge der eigenen Sitzung, gestreamt ohne Zwischendatei). Dateinamen im Archiv sind eindeutig (`a.mp3`, `a-2.mp3`); fehlgeschlagene, noch laufende, abgelaufene oder fremde Aufträge werden übersprungen und in `_uebersprungen.txt` aufgeführt. Download-Lease und Zeitlimit wie beim Einzeldownload. Der Endpunkt ist nur im Go-Backend vorhanden und nicht in `api/openapi.json`, das aus dem Python-Backend erzeugt wird.

Bilder: maximal 52.428.800 Bytes Eingabe, 40 MP, 16.384 px je Kante und 104.857.600 Bytes Ausgabe. Bis zu 30 Bilder je Stapel, zwei parallele Uploads und standardmäßig drei aktive Aufträge je Sitzung.

PDF: maximal 100.000.000 Bytes Eingabe, 300.000.000 Bytes über alle Ergebnisse und 40 MP je neu kodiertem Bild. Verschlüsselte oder nur durch Reparatur lesbare PDFs werden abgelehnt. Signaturen können ungültig werden; PDF/A-Erhalt ist nicht garantiert. Ergebnisse können größer werden; echte Größen werden angezeigt.

Audio: maximal 104.857.600 Bytes Eingabe, 1800 s Dauer (laut Header und beim Dekodieren gezählt), 8 Kanäle, 192.000 Hz und 419.430.400 Bytes Ausgabe. Verarbeitung blockweise, damit 1 GiB Adressraum reicht.

PDF zusammenführen: 2 bis 20 Dateien, 100.000.000 Bytes über alle Eingaben und ebenso viele Bytes Ergebnis, 2000 Seiten, Prozesszeitlimit 300 s. Alle Quellen sind gleichzeitig im Arbeitsspeicher des Parsers geöffnet (1 GiB Adressraum). `GET /api/v1/capabilities` meldet Verfügbarkeit und Grenzen unter `pdfMerge`.

Markdown: maximal 2.097.152 Bytes Eingabe, 20.971.520 Bytes PDF-Ausgabe, 300 Seiten und 120 Sekunden Prozesslaufzeit. Ungültiges UTF-8, leere/whitespace-only Dateien, Binärdaten und C0/C1-Steuerzeichen außer Tab/CR/LF werden abgelehnt. Serverfähigkeiten melden Verfügbarkeit und Grenzen; Fehler oder unvollständige Ergebnisse erzeugen keinen Download. Entfernen/Reset fordert wie bei den anderen Werkzeugen die Serverlöschung an.

Startwerte: eine Stunde Gültigkeit, 5 GB gemeinsames Dateibudget, 50 aktive Aufträge insgesamt, zehn Erstellversuche pro Minute je Sitzung und Client-IP. Prozesszeitlimit: 120 s Bild, 300 s PDF, 300 s Audio. Linux-Parser: 1 GiB Adressraum; Workercontainer: 1,5 GiB. Konfiguration: `server/internal/config/config.go`.

Metadaten/Farbprofile können entfernt oder verändert werden. Kein geprüftes Verfahren zur Metadatenbereinigung. Server- und Browserencoder erzeugen nicht dieselben Bytes.

## Dateien und Löschung

Dateien und bereinigte Namen liegen temporär auf dem Server. Inhalte, Namen, Cookies und Tokens gehören nicht in Logs. Die Anwendung speichert keine Dateien oder Tokens in Web Storage/IndexedDB.

Entfernen/Reset fordert Serverlöschung an. Bei Uploadabbruch oder Verlassen der Seite ist dies nur möglich, soweit eine Auftrags-ID bekannt ist; eine zuverlässige Löschung beim Schließen des Browsers wird nicht versprochen. Die reguläre Gültigkeit bleibt die Rückfallebene.

Nach Ablauf/Löschung sind neue Downloads gesperrt. Aktive Downloads sind zeitlich auf 300 s begrenzt. Cleanup läuft minütlich; bei gesundem Stack ist das konfigurierte physische Löschfenster zehn Minuten. Crashreste behalten bis zum sicheren Ende des Parserzeitlimits ihre Speicherreservierung. Bei gestoppten Diensten, DB-Ausfall oder Dateisystemfehlern kann sich Cleanup verzögern; es wird beim Wiederanlauf erneut ausgeführt. Dateivolumes nicht in Langzeitbackups aufnehmen.

Hostingprotokolle, Impressum und vollständige rechtliche Datenschutzhinweise muss der Betreiber vor Veröffentlichung regeln.

## Entwicklung und Tests

Frontend: Node 24 LTS und npm. Go benötigt lokal keine Installation: die isolierte Testumgebung enthält den gepinnten Compiler. Python 3.13 und uv werden nur für die privaten Codecs benötigt.

```sh
npm ci
npx playwright install chromium firefox webkit
npm run check
npm test
node scripts/generate-api-types.mjs --check
docker compose -f server/compose.test.yaml up -d --wait db valkey
docker compose -f server/compose.test.yaml run --rm go go vet ./...
docker compose -f server/compose.test.yaml run --rm go go test -race ./...
uv sync --frozen --project converter
uv run --project converter pytest converter/tests
uv run --project converter python scripts/smoke-stack.py
```

Der Smoke-Test braucht den vollständigen Stack. Go-Tests verwenden separate Testvolumes und Datenbanken; niemals die Testkonfiguration auf Nutzdaten richten. Die bisherigen lokalen Bild-/PDF-Engines bleiben durch Browser-Unit-Tests geprüft; die Website bietet keinen stillen lokalen Fallback.

Die vollständigen E2E laufen gegen den echten Compose-Stack. PowerShell:

```powershell
$env:E2E_BASE_URL = 'http://localhost:8080'
npm run test:e2e
```

Für große Testläufe teilen sich viele Sitzungen eine IP. CI setzt beim Compose-Start deshalb `CONVERTER_IP_CREATES_PER_MINUTE`, `CONVERTER_SESSION_CREATES_PER_MINUTE` und `CONVERTER_SESSION_NEW_PER_MINUTE` explizit auf 1000. Die normalen Limits werden separat geprüft. Diese Testwerte nicht für öffentliches Hosting übernehmen.

Ohne `E2E_BASE_URL` startet Playwright nur den statischen Previewserver; Serverwerkzeuge benötigen eine API. WebKit unter Windows ersetzt kein echtes Safari/iPhone. Der tatsächliche GitHub-Actions-Lauf erfolgt erst nach einem später autorisierten Push.

## Im Code orientieren

- `server/internal/httpapi/endpoints`: HTTP, Sitzung, Upload und Downloads.
- `server/internal/store` und `server/migrations`: PostgreSQL und Schemaänderungen.
- `server/internal/jobs`: Annahme, Queue, Worker, Recovery und Cleanup.
- `server/internal/converter`: begrenzte Go-Prozesssteuerung ohne Shell.
- `converter`: private Pillow-/pikepdf-/soundfile-Codecs ohne FastAPI oder Celery.
- `api/openapi.json`: kanonischer API-Vertrag; `src/lib/api`: Browserclient.
- `docs/go-backend`: Architektur, Betriebsanleitung, Prüfergebnisse und Commitlog.

Zum Lernen zuerst die Sitzungsroute lesen, dann `POST /jobs`, die Datenbanktransaktion, den Worker-Claim und den Konvertierungsprozess. `scripts/smoke-stack.py` zeigt den vollständigen HTTP-Ablauf.

`backend/` und `infra/compose.fastapi.yaml` bleiben ausschließlich als getesteter Rückweg und historische Referenz erhalten. Der normale Compose-Stack baut und startet keine FastAPI-/Celery-Dienste. Betriebswechsel: [Go-Betriebsanleitung](docs/go-backend/operations.md).
