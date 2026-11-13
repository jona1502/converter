# Punkt 5 – einheitliche Bildarbeitsbereiche

Stand: 03.11.2026. Implementierungsnachweis; unabhängiger Review und abschließende Produktions-/Browsermatrix bleiben eigene Arbeitspunkte.

## Umsetzung und Parität

`ToolWorkspace.tsx` vereinheitlicht ausschließlich die Darstellung. Die DOM-Reihenfolge lautet Auswahl → Einstellungen → Start → Dateien und Ergebnisse. Ab 1280 px stehen Auswahl/Ergebnisse links und die Einstellungen mit Start rechts in einer 22rem (352 px) breiten Spalte. Der spätere Spaltenwechsel berücksichtigt die schmale Desktopnavigation im gemeinsamen Seitenrahmen. Beide Spalten besitzen `min-width: 0`; unterhalb davon bleibt der Ablauf linear. Es gibt keine fixierte Startaktion und keinen zusätzlichen Upload-/Jobzustand.

Alle drei Bildwerkzeuge verwenden dieselben Abschnittsüberschriften und einen benannten Einstellungsbereich. Der bereits vorhandene Hinweis nach Einstellungsänderungen steht jetzt unmittelbar vor den unverändert verfügbaren Ergebnissen und erklärt ausdrücklich deren Bezug auf die vorherigen Einstellungen. Die bestehenden Bedingungen für diesen Hinweis bleiben erhalten.

Erhaltene Optionen und Verantwortlichkeiten:

- Konverter: capabilityabhängige Ausgaben, Qualität, Hintergrund, ICO-Größen, konvertierter Dateiname und unveränderte Abmessungen außerhalb des ICO-Vertrags.
- Kompressor: JPEG/WebP/PNG, Qualität, Hintergrund, ehrlicher PNG-Hinweis, optionale maximale Kante und vorhandene Eingabevalidierung ohne Vergrößern.
- Resizer: Prozent oder Breite/Höhe, Seitenverhältnis, ausdrückliche Upscale-Erlaubnis, Originalformat oder verfügbares Zielformat, Originalformatsperren, Qualität und Hintergrund.
- Alle drei: ursprüngliche Hook-/API-Aufrufe, Limits, Batchverarbeitung, Ankündigungen, Entfernen/Reset und Fokusrückgabe. Die vorhandenen Kommentare bleiben erhalten. `useImageBatch`, API-Client, gemeinsame Dateiliste, Dropzone, Optionen und Aktionsleiste wurden nicht geändert.

## Tatsächliche Prüfungen

Quelle: eigener Astro-Entwicklungsserver unter `http://127.0.0.1:4335`, gestartet mit `npm run dev -- --host 127.0.0.1 --port 4335`.

| Prüfung | Tatsächliches Ergebnis |
| --- | --- |
| RED vor Implementierung: `E2E_BASE_URL=http://127.0.0.1:4335 npx playwright test e2e/image-workspace.spec.ts --project=chromium --workers=2 --timeout=15000` | Alle sechs neuen Fälle scheiterten am erwarteten fehlenden Einstellungsänderungshinweis innerhalb der Ergebnisregion. Beim Traceabschluss gab es zusätzlich eine Artefaktkollision mit einem parallelen anderen Testlauf; nachfolgende Läufe verwenden getrennte Ausgabepfade. |
| GREEN: gleicher neuer Test mit `--output=test-results/task5-green` | 6/6 bestanden, 3,2 Sekunden. Die Inline-Style-Prüfung beschränkt sich auf den Produktinhalt in `main`; die Astro-Entwicklungsleiste gehört nicht zum Produktionsinhalt. |
| `E2E_BASE_URL=http://127.0.0.1:4335 npx playwright test e2e/image-workspace.spec.ts e2e/server-errors.spec.ts --workers=2 --timeout=20000 --output=test-results/task5-browsers` | 36/36 bestanden, 31,1 Sekunden: Chromium, Firefox, WebKit und mobiles Chromium. |
| `npm run check` | 98 Dateien, 0 Fehler, 0 Warnungen, 0 Hinweise. |
| `npm run build` | Erfolgreich; sieben statische Seiten erzeugt, 1,55 Sekunden. |
| `git diff --check` | Keine Whitespacefehler. |

Die sechs neuen Fälle decken jeweils alle drei Werkzeuge bei 320 und 1440 px ab: Abschnittsreihenfolge im DOM, kein Upload vor Start, genau ein ausdrücklicher Start, verbleibender Download nach Optionswechsel mit zugeordnetem Änderungshinweis, langer Dateiname ohne horizontalen Dokumentüberlauf und keine Inline-Styles im Produktinhalt. Die unveränderten Serverfehlertests prüfen 429/Idempotenz, deutsche Serverfehlermeldung ohne lokalen Ersatz und Netzabbruch mit manuellem Neustart.

Zwei lokale Screenshots des Resizers bei 1440 und 320 px wurden visuell geprüft: Desktopspalten passen neben die neue Navigation, mobile Bereiche stehen in der vorgegebenen Reihenfolge, die Einstellungen und Aktionen sind nicht überlagert. Die Astro-Entwicklungsleiste ist dabei als Entwicklungsoberfläche sichtbar. Diese Stichprobe ersetzt keine vollständige visuelle Matrix.

## Beweisgrenzen

Die Browserprüfungen dieses Punkts verwenden API-Doubles. Sie beweisen UI-Zuordnung, Bedienbarkeit der geprüften Zustände und die bestehende Uploadgrenze; sie beweisen keine echte Bildkodierung. Die bestehenden realen `convert.spec.ts`, `compress.spec.ts` und `resize.spec.ts` wurden unverändert erhalten und gehören zur abschließenden Prüfung gegen den neu gebauten Serverstack. Die vollständige Unitwiederholung bleibt ebenfalls der koordinierten Endabnahme vorbehalten; der Verarbeitungskern wurde hier nicht geändert.

Hell/Dunkel, sämtliche Viewports, 200 % Zoom, reduzierte Bewegung, vollständige Tastatur-/Axe-Matrix, 30/31 Dateien und die ganze Formate-/Resizermatrix werden hier nicht pauschal als abgenommen erklärt. Gemeinsame Auswahl-/Ergebnisbausteine bleiben Punkt 6; weitere Textkorrekturen bleiben Punkt 8.
