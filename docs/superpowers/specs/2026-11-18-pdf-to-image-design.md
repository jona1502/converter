# PDF zu Bild

## Ziel

Neues Werkzeug `/pdf/zu-bild`: genau eine PDF auswählen, Ausgabeformat (PNG, JPEG, WebP), Auflösung (DPI) und Seitenauswahl festlegen, ausdrücklich „Bilder erstellen“ starten, Fortschritt sehen und das Ergebnis herunterladen. Eine einzelne Seite ergibt ein Bild, mehrere Seiten ergeben ein ZIP-Archiv mit einem Bild je Seite. Verarbeitung serverseitig im bestehenden isolierten Konverterprozess; Auswählen allein lädt nichts hoch.

## Entscheidung Rasterisierer: pypdfium2 (PDFium)

Gewählt ist **pypdfium2 5.14.0** (PDFium 156.0.8076.0). Es ist im Repository bereits als unabhängiger Testrenderer gesperrt (`converter/uv.lock`, `docs/backend/feasibility/README.md`, Abschnitt „Umgebung“) und wird für das neue Werkzeug von der Dev- in die Laufzeitgruppe verschoben.

| Kriterium | Bewertung |
| --- | --- |
| Lizenz | pypdfium2: BSD-3-Clause oder Apache-2.0 (Wahl), PDFium: BSD-3-Clause bzw. Apache-2.0; Abhängigkeiten laut mitgelieferten Lizenztexten permissiv. Keine Copyleft-Pflicht für den Netzwerkdienst. |
| Verbreitung | Das Linux-Wheel (manylinux, cp313-unabhängig, `py3-none`) bündelt die PDFium-Bibliothek. Das Image braucht weiterhin keine Systempakete, keinen `apt`-Schritt und keinen Kindprozess. |
| Speicher | Der Prozess läuft unverändert unter `RLIMIT_AS` (1 GiB). Die Bitmap-Größe ist vor dem Rendern aus Seitengröße und DPI bekannt und wird auf 40 Megapixel je Seite begrenzt (bei 3 Byte je Pixel etwa 120 MB, dazu eine PIL-Kopie und Encoderpuffer). Es wird immer nur eine Seite gleichzeitig gerendert; Bitmap und Bild werden je Seite freigegeben. |
| Sicherheit | Läuft im selben Sandboxprozess wie Pillow und pikepdf: Seccomp verbietet neue Sockets, Parent-Death-Signal, Wall-Timer, `RLIMIT_CPU`, `RLIMIT_FSIZE`. PDFium wird ohne V8 und ohne XFA gebaut, JavaScript in PDFs wird daher nicht ausgeführt; Formularfelder werden nicht initialisiert, externe Ressourcen nicht geladen. Der Import erfolgt wie bei allen nativen Parsern erst nach `sandbox.isolate`. Verschlüsselte PDFs werden vorher mit pikepdf abgewiesen. |
| Qualität | Produktionsrenderer von Chromium: Text, Vektoren, Transparenz, eingebettete Schriften, Farbräume. |

### Verworfene Alternativen

- **MuPDF / PyMuPDF und Ghostscript:** AGPL-3.0 beziehungsweise kommerziell. Ein netzwerkzugänglicher Dienst müsste den Quelltext des Gesamtwerks anbieten. Bereits in der Machbarkeitsstudie ausgeschlossen.
- **Poppler (`pdftoppm`, GPL-2.0/3.0):** Copyleft, braucht Systempakete im Worker-Image, einen zusätzlichen Kindprozess (Seccomp-/Prozessgruppenmodell des Konverters wäre zu erweitern) und liefert Fortschritt nur über Dateien.
- **Rendern im Browser (pdf.js):** widerspricht dem Produktprinzip der serverseitigen Verarbeitung der übrigen PDF-Werkzeuge und dem CSP-Modell (Worker, WASM) und hätte keine harten Speichergrenzen.

## Bedienung und Optionen

Optionen `{"tool":"pdf-to-image", "format":"png|jpeg|webp", "dpi":72..300, "pages":"all|<Liste>", "quality":0..1}`.

- `format`: Pflicht. `quality` (Standard 0,85) wirkt nur bei JPEG und WebP, wie bei den Bildwerkzeugen.
- `dpi`: Ganzzahl 72 bis 300, Standard 150. Die Oberfläche bietet 72, 150 und 300 an.
- `pages`: `all` (Standard) oder kommagetrennte Seitennummern und Bereiche ab 1, zum Beispiel `1-3,5`. Der Server normalisiert aufsteigend, ohne Duplikate und ohne Leerzeichen. Mehr als 100 gewählte Seiten sind ungültig.
- Genau eine explizit gewählte Seite liefert **ein Bild**, jede andere Auswahl (auch `all`) ein **ZIP**. Die Oberfläche kennt die Seitenzahl bereits lokal und sendet bei einseitigen PDFs `1`, damit dort ein Bild entsteht. Diese Festlegung trifft der Server bei der Annahme, sodass Name und MIME des Ergebnisses von Anfang an feststehen.
- Download: Bild `<Stamm>-seite-<n>.<ext>`, Archiv `<Stamm>-bilder.zip` mit `seite-001.<ext>`, `seite-002.<ext>` …

## Grenzen

| Grenze | Wert | Quelle |
| --- | --- | --- |
| Eingabegröße | 100 000 000 Byte | bestehend `PDF_MAX_INPUT_BYTES` |
| Seiten je Auftrag | 100 | neu `PDF_IMAGE_MAX_PAGES` |
| Pixel je gerenderter Seite | 40 000 000 | bestehend `PDF_IMAGE_MAX_PIXELS` |
| Kante je Seite | 16 383 (WebP-Grenze) | Konverter |
| Ergebnisgröße | 300 000 000 Byte | bestehend `PDF_MAX_RESULTS_TOTAL_BYTES` |
| Laufzeit | 300 s | bestehend `PDF_TIMEOUT_SECONDS` |

Fehler: verschlüsselte PDF `encrypted` (auch bei leerem Benutzerkennwort), beschädigte PDF `parse-failed`, zu große Seite `dimensions-too-large`, zu viele Seiten oder zu großes Archiv `result-too-large`, Seitenauswahl außerhalb des Dokuments `parse-failed`. Fehlerhafte oder unfertige Ergebnisse werden nicht zum Download freigegeben.

## Technische Integration

Neues Werkzeug `pdf-to-image` mit Eingabeformat `pdf` und einem Ergebnis. Die Datenbank-Constraints erhalten das Werkzeug additiv (Migration). Capabilities enthalten `pdfImage` mit Verfügbarkeit (echte Rundreise-Probe), Formaten, DPI-Bereich und Grenzen. Der API-Vertrag `api/openapi.json` bleibt kanonisch. Fortschritt meldet der Konverter je Seite im bestehenden Schritt `encode` (`current`/`total` in Seiten).

## Nachweise

Python: echte Rundreisen mit unabhängiger Prüfung der Bildgröße und des Inhalts, ZIP-Struktur, Grenzen, verschlüsselte und beschädigte PDFs. Go: Optionsvalidierung, Namen, Annahme, Capabilities, Details und Protokoll. Frontend: Optionsprüfung, Katalog, Seitenbereichsparser, expliziter Start. E2E mit Mock-API wie bei den anderen Werkzeugen. Nicht lokal ausführbare Prüfungen (Datenbank, Linux-Sandbox) werden ausdrücklich dokumentiert.
