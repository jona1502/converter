# Punkt 7 – PDF-Arbeitsbereich und Varianten

Stand: 03.11.2026. Implementierungsnachweis; unabhängiger Review und vollständige Produktions-/Gestaltungsmatrix folgen getrennt.

## Umsetzung

`PdfCompressor.tsx` nutzt den rein darstellenden `ToolWorkspace` mit derselben DOM-Reihenfolge wie die Bildwerkzeuge: Auswahl → Einstellungen → Start → Ergebnisse. Die PDF-Auswahl enthält den langen Dateinamen und die tatsächliche Eingangsgröße; der Start befindet sich im eigenen Aktionsabschnitt. Die drei bestehenden Qualitätsstufen werden gemeinsam berechnet und als feste Einstellungen erklärt. Es gibt keine neue Stufe, keine neue Bibliothek und keinen zweiten Upload-/Jobzustand.

Analyse und Varianten sind beschriftete Unterabschnitte. Seiten, Bilder, komprimierbare Bilder und Originalgröße bleiben sichtbar; eine gelieferte PDF-Version wird ebenfalls angezeigt. Der Hinweis auf ausschließlich verlustfreie Optimierung bleibt erhalten. Der Serverhinweis zu ungültig werdenden digitalen Signaturen wird aus der tatsächlichen Analyse angezeigt; verschlüsselte PDFs werden weiterhin durch den bestehenden Serververtrag abgelehnt.

Jede fertige Variante zeigt Originalgröße, Ergebnisgröße und reale Änderung in einer Beschreibungsliste. Größere und unveränderte Ergebnisse werden ausdrücklich so bezeichnet. Während die übrigen Varianten noch laufen, kann ein bereits gelieferter erfolgreicher Download genutzt werden. Teilfehler bleiben ihrer Variante zugeordnet; andere Downloads bleiben verfügbar. Abgelaufene Varianten heißen „Abgelaufen“ und bieten keine Links mehr an. Erfolg, Teilfehler und Ablauf erhalten eine Meldung in der vorhandenen Live-Region.

Die vorhandenen Capabilities-, Upload-, Polling-, Abbruch-, Lösch-, Ablauf- und Generation-Aufrufe wurden nicht umgebaut. Ausdrücklicher Start, Idempotenzschlüssel, tatsächliche Fortschrittswerte, Zurücksetzen und Fokusrückgabe bleiben erhalten. `src/pages/pdf/komprimieren.astro` blieb unverändert und ist für die koordinierte Textarbeit in Punkt 8 frei.

## Tatsächliche Prüfungen

Die neuen `e2e/pdf-workspace.spec.ts`-Fälle verwenden API-Doubles und prüfen den echten React-/API-Client-Ablauf im Browser. Eine echte PDF-Kodierung wird damit nicht behauptet.

| Prüfung | Tatsächliches Ergebnis |
| --- | --- |
| Auswahl-RED, Chromium, 320/1440 px, `--output=test-results/task7-selection-red` | 2/2 erwartete Fehler: die vier Arbeitsbereichsüberschriften fehlten. |
| Auswahl-GREEN, `--output=test-results/task7-selection-green` | 2/2 bestanden: Abschnittsreihenfolge, kein Upload vor Start, reale Größe, langer Name ohne horizontalen Überlauf, Reset mit Fokusrückgabe. |
| Varianten-RED, `--grep='laufende PDF' --output=test-results/task7-variants-red` | Erwarteter Fehler: der beschriftete Analyseabschnitt fehlte. |
| Varianten-GREEN, `--output=test-results/task7-variants-green` | 3/3 bestanden, einschließlich einer bereits fertigen Variante während der Verarbeitung und anschließendem Teilfehler. |
| Ablauf-RED, `--grep='Ablauf wird' --output=test-results/task7-expiry-red-retry` | Erwarteter Fehler: Ablauf war nicht in der Live-Region angekündigt. Der erste Versuch unter `task7-expiry-red` traf nur auf den inzwischen gestoppten Entwicklungsserver; diese Verbindungsverweigerung ist kein Produktnachweis. |
| Lebenszyklus-GREEN, Chromium, `--output=test-results/task7-lifecycle-green` | 7/7 bestanden, 11,1 Sekunden. |
| `E2E_BASE_URL=http://127.0.0.1:4337 npx playwright test e2e/pdf-workspace.spec.ts --workers=2 --output=test-results/task7-browsers` | 28/28 bestanden, 36,2 Sekunden: Chromium, Firefox, WebKit und mobiles Chromium. |
| Axe in leerem, fertigem und verschlüsselt abgelehntem Zustand | In allen vier Browserprojekten keine Verstöße im Hauptinhalt; keine deaktivierten Regeln. |
| `npm run check` nach den ersten beiden PDF-Teiländerungen | Jeweils 99 Dateien, 0 Fehler, 0 Warnungen, 0 Hinweise. |
| `npm run build` nach der finalen PDF-Änderung | Erfolgreich, sieben statische Seiten, 1,45 Sekunden. |
| Späteres `npm run check` im gleichzeitig bearbeiteten Gesamtbaum | Ein zwischenzeitlicher Punkt-6-Befund: `FileList.tsx:63`, `InputFormat` nicht zu `OutputFormat` zuweisbar. Der Koordination gemeldet; keine fehlerfreie Gesamtbaumprüfung aus diesem Lauf abgeleitet. |
| `git diff --check -- src/components/tools/PdfCompressor.tsx e2e/pdf-workspace.spec.ts` | Keine Whitespacefehler. |

Die zusätzlichen Lebenszyklusfälle belegen: Abbrechen bewahrt eine bereits erfolgreiche Variante und beendet die anderen; Reset sendet DELETE, führt den Fokus zurück und lässt eine verspätete Pollantwort nicht wieder erscheinen; der Ablauf entfernt alle Downloads und erlaubt einen neuen ausdrücklichen Start. Die Größenfixtures enthalten kleinere, größere und unveränderte Ausgaben. Der verschlüsselte Fehlerzustand besitzt keine Downloads; ein bildloses Ergebnis behält den Hinweis auf begrenzte Einsparung.

Zunächst wurde der vorhandene Entwicklungsserver auf Port 4335 mitgenutzt, weil Astro einen zweiten Prozess für denselben Checkout ablehnte. Nach dessen Ende wurde der eigene Entwicklungsserver auf Port 4337 gestartet. Er bleibt für die anschließenden koordinierten Aufgaben aktiv; die Testausgaben liegen getrennt unter `test-results/task7-*`.

## Beweisgrenzen und Übergabe

Die unveränderten realen `e2e/pdf.spec.ts`-Fälle gehören zur abschließenden Prüfung gegen den neu gebauten Linuxstack. Weder die API-Doubles noch die Quellbrowserprüfung ersetzen die reale PDF-Verarbeitung oder den Sandbox-/Speichervertrag. Eine neue vollständige Unitsuite und der vollständige Realstack wurden für diese Präsentationsänderung nicht wiederholt.

Keine vollständige visuelle Abnahme von Hell/Dunkel, 390/768 px, 200 % Zoom, reduzierter Bewegung oder sämtlichen Tastaturfolgen wurde hier durchgeführt. Die geprüfte mobile Reihenfolge, der lange Dateiname und die fokussierten Axe-/Lebenszyklusfälle sind konkrete Teilnachweise. Weitere Textkorrekturen bleiben Punkt 8; unabhängiger Review und endgültige Matrix bleiben Punkt 9/10.

Teilcommits: `0353faf` (Auswahl, Einstellungen und Aktionen), `a7de140` (Analyse und Varianten). Der Lebenszyklus-/Nachweiscommit ist mit `git log -1 --format=%H -- docs/superpowers/reviews/task7-pdf-workspace.md` bestimmbar; seine feste ID folgt beim nächsten regulären Ledgerupdate.
