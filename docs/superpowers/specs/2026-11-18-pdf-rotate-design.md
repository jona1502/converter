# PDF drehen

## Ziel und gewählter Ansatz

Die Website erhält ein Werkzeug, das alle oder ausgewählte Seiten einer PDF um 90, 180 oder 270 Grad im Uhrzeigersinn dreht. Gedreht wird ausschließlich über den Seiteneintrag `/Rotate`; Seiteninhalte werden weder gerastert noch neu kodiert oder komprimiert. Dadurch bleiben Text, Vektoren, Bilder und Qualität unverändert, und die Ausgabe ist etwa so groß wie die Eingabe. Sitzung, Upload, Queue, isolierte Verarbeitung, Download und Löschung werden wiederverwendet.

## Bedienung

Neue Seite `/pdf/drehen`, Titel „PDF drehen“, im Werkzeugverzeichnis unter der neuen Aktion „Drehen“. Eine PDF auswählen; die Vorprüfung (Größe, `%PDF-`-Signatur) und die Prüfung der Seitenangabe laufen lokal, nichts wird hochgeladen. Einstellungen: Drehwinkel (90, 180, 270) und „Alle Seiten“ oder „Bestimmte Seiten“ mit Seitenangabe wie `1-3,5`. Erst „PDF drehen“ startet den Auftrag. Das Ergebnis zeigt Drehung, gedrehte Seiten von Gesamtseiten, Größe und Dateiname und bietet genau einen Download. Entfernen fordert die frühere Löschung an.

## Optionen und Ergebnis

```json
{"tool": "pdf-rotate", "angle": 90, "pages": "all"}
```

- `angle`: ganze Zahl 90, 180 oder 270, Pflicht.
- `pages`: `all` (Standard) oder Liste aus Seiten und Bereichen (`1-3,5`), 1-basiert, ohne Leerzeichen, Vorzeichen und führende Nullen, jede Zahl höchstens sieben Stellen, Bereiche aufsteigend, insgesamt höchstens 256 Zeichen. Unbekannte Felder oder `null` werden abgelehnt.
- Kanonische Optionen enthalten immer beide Felder, damit Idempotenzschlüssel stabil bleiben.
- Ergebnis: genau eine `application/pdf`, Name `<bereinigter Stamm>-gedreht.pdf`, `details` = `{"pageCount": n, "rotatedPages": m}` mit `1 <= m <= n`.
- Eine bereits gesetzte (auch geerbte) Drehung wird addiert und modulo 360 normalisiert. Mehrfach genannte Seiten werden nur einmal gedreht.

## Technische Integration

- Python (`converter`): `rotate_options.py` (Optionen, Seitenlisten), `processing/pdf/rotate.py` (pikepdf, `Page.rotate(relative=True)`), Dispatch in `execute.py`. Eingabe wird wie bei der Komprimierung über `open_source` geöffnet: Größenlimit, Signatur, Verschlüsselung und kaputte Dateien werden mit `file-too-large`, `not-pdf`, `encrypted` bzw. `parse-failed` abgelehnt, Reparaturmodus ist aus. Seiten hinter dem Dokumentende ergeben `invalid-options`. Die Ausgabe wird gegen das Ausgabelimit begrenzt (`result-too-large`).
- Go: Werkzeug `pdf-rotate` in `apitypes`, Optionsvalidierung in `httpapi/endpoints/options_rotate.go` (gleiche Grammatik wie Python und Browser), Ergebnisdetails strikt in `converter/rotate.go`, Name und Arbeitsreserve in `jobs/rotate.go`. Eingabegrenze und Signaturprüfung entsprechen `pdf-compress`. Zeitlimit ist das PDF-Zeitlimit.
- Arbeitsreserve je Auftrag: doppelte Eingabegröße plus 1 MiB, höchstens das PDF-Gesamtbudget; das Ausgabelimit des Konverters folgt dieser Reserve.
- Capabilities: `pdfRotate` mit `available`, `maxFileBytes`, `maxOutputBytes` und `angles`. Verfügbarkeit folgt der PDF-Rundreise der Capability-Probe (pikepdf).
- Neue additive Migration `0006_pdf_rotate.sql` erweitert nur `ck_jobs_tool`.
- `api/openapi.json` bleibt kanonisch; `src/lib/api/generated.ts` wird daraus erzeugt.

## Grenzen und Sicherheit

Dieselbe Sandbox wie alle Konverteraufrufe: kein Netzwerk, Speicher-, Zeit- und Dateigrößenlimits, keine Symlinks, Ereignisse ohne Pfade. Eingabegrenze `PDF_MAX_INPUT_BYTES` (100.000.000 Bytes), Ergebnis höchstens das PDF-Gesamtbudget (300.000.000 Bytes), 300 s Prozesslaufzeit. Verschlüsselte PDFs werden nicht entschlüsselt. Digitale Signaturen werden durch das Neuschreiben der PDF ungültig; PDF/A-Konformität ist nicht garantiert. Seitenlisten sind begrenzt, sodass keine unbegrenzten Mengen entstehen.

## Nachweise

Python-Tests prüfen Optionen und Seitenlisten, Drehung aller und gewählter Seiten, relative und geerbte Drehung, unveränderte Inhaltsströme und MediaBox, Verschlüsselung, Nicht-PDF, kaputte PDF, Größen-, Ausgabe- und Seitengrenzen sowie den Prozessaufruf. Go-Tests prüfen Optionsgrammatik, Vertrag (OpenAPI), strikte Details, Protokollverhalten, Ergebnisnamen und Arbeitsreserve, Capabilities, Upload-Ablehnungen, Migration und Worker (die Datenbanktests benötigen den Teststack). Vitest prüft Seitenangabe, Optionen, Vorprüfung und Meldungen; Playwright prüft das Verhalten mit gemockter API in allen vier Browserprojekten und mit dem echten Stack.

## Offen

PDFs mit digitalen Signaturen werden nicht gewarnt. Die Startseite öffnet das Werkzeug nicht direkt für abgelegte PDFs; sie bleibt bei „PDF komprimieren“. Eine Seitenzahl-Vorschau im Browser gibt es nicht; die Existenz der Seiten prüft der Server.
