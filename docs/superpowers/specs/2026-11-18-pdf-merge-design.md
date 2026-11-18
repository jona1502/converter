# PDF zusammenführen

## Ziel

Neue Seite `/pdf/zusammenfuehren`: Zwei bis zwanzig PDFs auswählen, die Reihenfolge ändern und ausdrücklich zu genau einer PDF zusammenführen lassen. Sitzung, Uploadlimits, Queue, isolierter Prozess, Downloads und Löschung des Markdown-Werkzeugs werden wiederverwendet. Auswählen, Prüfen und Sortieren laden nichts hoch.

## Bedienung

Dateien per Auswahl oder Ablage hinzufügen (auch nacheinander). Jede Datei wird lokal auf Größe und PDF-Signatur geprüft. Die Reihenfolge wird mit „Nach oben“, „Nach unten“ und „Entfernen“ geändert; das geht per Tastatur, der Fokus bleibt auf der bewegten Zeile und jede Verschiebung wird angesagt. „PDFs zusammenführen“ ist erst mit mindestens zwei gültigen Dateien und innerhalb der Grenzen möglich. Jede Änderung der Liste verwirft ein vorhandenes Ergebnis und fordert die Serverlöschung des Auftrags an. Auf der Startseite bietet eine abgelegte Auswahl von mindestens zwei PDFs „PDFs zusammenführen“ an und übergibt alle PDFs.

Bewusst nicht enthalten: Ziehen zum Umsortieren, Seitenauswahl je Datei, Passwortabfrage für verschlüsselte PDFs.

## API

Werkzeug `pdf-merge`, Optionen `{"tool":"pdf-merge"}` (keine weiteren Felder; unbekannte Felder ergeben `invalid-request`). `POST /api/v1/jobs` nimmt nach dem Teil `options` zwei bis zwanzig Teile `file` in Reihenfolge entgegen. Ergebnis: genau eine `application/pdf` mit festem Namen `zusammengefuehrt.pdf`, Details `{"pageCount": n, "sourceCount": m}`. `GET /api/v1/capabilities` meldet `pdfMerge` mit `available`, `minFiles`, `maxFiles`, `maxTotalBytes`, `maxOutputBytes` und `maxPages`. Der Vertrag steht in `api/openapi.json`.

## Grenzen und Fehler

- 2 bis 20 Dateien, zusammen höchstens `PDF_MAX_INPUT_BYTES` (Standard 100.000.000 Bytes); Ergebnis ebenfalls höchstens diese Größe und 2000 Seiten.
- Zeitlimit wie bei PDFs (300 s), Arbeitsspeichergrenze des Parsers unverändert (1 GiB Adressraum). Alle Quellen sind gleichzeitig geöffnet; die Grenzen sind so gewählt, dass das hineinpasst.
- Fehlercodes: `not-pdf` (Teil ist keine PDF), `unsupported-type` (leere Datei), `file-too-large`, `missing-file` (weniger als zwei Dateien oder falscher Teilname), `invalid-request` (mehr als zwanzig Dateien), `encrypted`, `parse-failed` (beschädigt oder nur durch Reparatur lesbar), `dimensions-too-large` (mehr als 2000 Seiten), `result-too-large`, `save-failed`.
- Seiten werden unverändert übernommen. Lesezeichen, Formularfelder, Dokumenteigenschaften und Signaturen der Quellen werden nicht übernommen; Signaturen werden ungültig.

## Technik

Ein Auftrag kennt genau eine Eingabedatei. Der Upload-Handler schreibt deshalb alle PDFs als Bündel in diese eine Spooldatei (`server/internal/jobs/pdfmerge_bundle.go`): Kopf `MIPDFMRG1\n`, je Datei Blöcke aus `uint32`-Länge und Daten mit Abschluss durch Länge 0, das Ende ist eine Datei ohne Blöcke. Dadurch bleiben Reservierung, Hash, Idempotenz, Replay, Speicherbudget und Cleanup unverändert. Jede Datei wird beim Streamen gegen das verbleibende Gesamtbudget geprüft und als PDF erkannt; die Bündelgröße darf die Reservierung nicht übersteigen. Der Python-Prozess (`converter/converter/processing/pdf_merge/`) liest das Bündel defensiv (jede Länge wird vor der Speicherbelegung gegen Restgröße und Budget geprüft), öffnet jede Quelle ohne Reparaturversuch, lehnt Verschlüsselung ab und kopiert die Seiten mit pikepdf. Ein Golden-Byte-Test sichert Go-Schreiber und Python-Leser gegeneinander ab.

Migration `0006_pdf_merge.sql` erweitert nur den Werkzeug-Constraint; das Eingabeformat bleibt `pdf`. Die Verfügbarkeit folgt der bestehenden PDF-Probe, ein eigener Bericht ist nicht nötig.

## Nachweise

Go-Tests: Bündel (Reihenfolge, kurze Reads, Grenzen, Golden), Teilparser (Reihenfolge, Dateianzahl, Typ, Größe), Optionen, Details, Capabilities, Vertragstests. Python: Reihenfolge und Seitenzahl, Rotation und vererbte Seitengröße, verschlüsselte, beschädigte und fremde Dateien, fehlerhafte Bündel, Grenzen, sandboxed CLI. Browser: Vorprüfung, Reihenfolge, Grenzen, Meldungen. E2E mit API-Doubles in allen Browsern sowie ein Test gegen den echten Stack.
