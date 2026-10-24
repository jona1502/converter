# MI converter

Statische, deutschsprachige Astro-Website mit lokaler Dateiverarbeitung. React-Inseln bilden die interaktiven Werkzeuge, TypeScript prüft die Schnittstellen, Tailwind CSS gestaltet die Oberfläche.

## Lokal starten

Node.js 22.23.4 oder neuer aus einer von den Werkzeugen unterstützten Versionslinie verwenden (empfohlen Node 24 LTS; Vitest 5 unterstützt Node 22, 24 und ab 26, nicht Node 25). npm und Lockdatei verwenden:

```sh
npm ci
npx playwright install chromium firefox webkit
npm run dev -- --port 3000
```

## Prüfen und bauen

```sh
npm run check
npm test
npm run build
npm run test:e2e
```

`npm run verify` führt alle Prüfungen aus. Browser-Unit-Tests laufen in Chromium, Firefox und WebKit. E2E prüft den Produktionsbuild auf Port 4329 zusätzlich in mobilem Chromium. Zwei E2E-Worker begrenzen die Last auf dem Entwicklungsgerät. Playwright-WebKit unter Windows ersetzt keinen Test auf echtem Safari/iOS.

`npm run preview` zeigt den fertigen Build lokal. `dist/` enthält die statischen Dateien. Deployment, Docker, CI und Hosting-Konfiguration gehören nicht zu diesem Release.

## Werkzeuge

- Bilder konvertieren: JPEG, PNG, WebP, BMP und ICO als Ausgabe. Statische JPEG/PNG/WebP/GIF/BMP/ICO/AVIF als Eingabe, soweit der Browser sie dekodieren kann.
- Bilder komprimieren: Qualität bei JPEG/WebP und optionale Begrenzung der längsten Kante. PNG hat keinen wirksamen Browser-Qualitätsregler; kleinere Ergebnisse sind nicht garantiert.
- Bilder skalieren: Prozent oder Zielabmessungen, Seitenverhältnis standardmäßig erhalten, Vergrößerung ausdrücklich aktivieren.
- PDF komprimieren: drei nacheinander erzeugte Varianten mit tatsächlicher Größe und Größenänderung. Keine festen Schätzungen und keine garantierten Einsparquoten.

Größenanzeigen verwenden dezimale KB/MB und deutsche Zahlenformatierung. Unter 1.000.000 Bytes erscheinen KB, ab 1.000.000 Bytes MB.

## Architektur

- `src/pages/`, `src/layouts/`: statische Seiten und Rahmen.
- `src/components/tools/`: React-Werkzeuge und gemeinsame Dateiverwaltung.
- `src/lib/image/`: Headerprüfung, Grenzwerte, Decoder-/Encoder-Prüfung, Canvas-Pipeline und Worker-Pool. BMP und ICO besitzen eigene Encoder.
- `src/lib/pdf/`: PDF-Analyse und Bild-Neukodierung mit `@cantoo/pdf-lib`, ein serieller Modul-Worker.
- `src/lib/format.ts`: gemeinsame Größenformatierung.
- `tests/unit/`, `e2e/`: echte Browser-Tests.
- `docs/implementation-plan.md`, `docs/commit-log.md`: Arbeitspunkte und dokumentierte Commits.

## Datenschutz

Kein Backend, keine Uploads, Konten, Datenbank, Analytics oder Laufzeit-CDNs. Ausgewählte Dateien und Ergebnisse liegen im Arbeitsspeicher. Entfernen, Zurücksetzen und Verlassen des Werkzeugs lösen Referenzen, Ergebnis-URLs und gegebenenfalls Worker; wann der Browser den Speicher tatsächlich zurückgewinnt, entscheidet seine Speicherverwaltung. Downloads werden vom Browser auf dem Gerät gespeichert.

Die Anwendung schreibt Dateien nicht in Local Storage, IndexedDB oder Cache Storage. Das Hosting erhält gewöhnliche Anfragen für Seite und statische Ressourcen; dessen Zugriffsprotokollierung muss der Betreiber selbst regeln.

Eine CSP im HTML blockiert unter anderem `connect-src`. Modul-Worker erben eine Meta-CSP nicht; ihr eigener Code enthält keine Netzwerkaufrufe. Für Hosting sollten eine passende CSP als HTTP-Header und `frame-ancestors 'none'` ergänzt werden. Impressum und rechtliche Datenschutzhinweise muss der Betreiber vor Veröffentlichung ergänzen.

## Grenzen

Bilder: maximal 30 Dateien, jeweils 52.428.800 Bytes (50 MiB), 40 Megapixel und 16.384 Pixel je Kante. BMP-Ausgabe maximal 104.857.600 Bytes (100 MiB). Verarbeitung mit höchstens zwei parallelen Aufträgen, auf schwächeren Geräten einem. Animierte Bilder werden abgelehnt. ICO enthält PNG-basierte Einträge von 16 bis 256 Pixeln. BMP ist 24-bit ohne Alpha; Transparenz wird mit der gewählten Farbe gefüllt.

Bild-Neukodierung kann EXIF/GPS, Farbprofile und andere Metadaten entfernen oder verändern. Sie ist kein geprüftes Verfahren zur Metadatenbereinigung. Erneute JPEG-Kodierung ist verlustbehaftet. Manche beschädigten Bilder werden von Browsern teilweise dekodiert, ohne einen Fehler zu melden.

PDF: maximal 100 MB Eingabe, 300 MB Ergebnisbudget für drei Varianten und 40 Megapixel je neu kodiertem Bild. Die Stufen verwenden 300/150/100 DPI, zusätzliche Kantenlimits und unterschiedliche JPEG-Qualitäten. Texte und Vektoren werden nicht als ganze Seiten rasterisiert. Nicht sicher unterstützte Bilder, insbesondere Transparenzmasken, spezielle Farbräume, CMYK, JPX/JBIG2/CCITT und nicht unterstützte Filterketten, bleiben unverändert. Schriften werden nicht verkleinert. Bereits optimierte oder textlastige PDFs können gleich groß oder größer werden.

PDF-Neuschreiben kann digitale Signaturen ungültig machen; das Werkzeug weist darauf hin. Verschlüsselte PDFs werden abgelehnt. PDF/A-Konformität wird nicht garantiert. Große oder komplexe Dokumente können trotz Grenzwerten den Arbeitsspeicher überlasten: Ein harter Speicherdeckel für den PDF-Parser ist im Browser nicht möglich. Die PDF-Komprimierung benötigt insbesondere OffscreenCanvas im Worker; Browser ohne diese Unterstützung erhalten einen verständlichen Hinweis. Bildwerkzeuge können dort auf den Hauptthread ausweichen.

DOCX↔PDF, Audio, Video, ZIP-Sammeldownload und ein optionales Backend sind spätere Erweiterungen.
