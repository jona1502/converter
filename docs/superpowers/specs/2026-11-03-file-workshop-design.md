# Dateiwerkstatt – verbindliche Designspezifikation

**Stand:** 03.11.2026. **Freigabe:** Der Nutzer hat den Redesignplan zur Umsetzung freigegeben; damit wird dessen empfohlene Richtung „Dateiwerkstatt“ konkretisiert. Diese Spezifikation ist die fachliche Autorität für die Gestaltung. [Ausführungsplan](../plans/2026-11-03-redesign-audit-plan.md) und [Fortschrittsledger](../progress.md) trennen Umsetzung von noch offenen technischen Nachweisen.

## Ziel und Umfang

MI converter erhält eine ruhige, warme Arbeitsoberfläche mit klaren Linien, sichtbarer Werkzeugauswahl und vergleichbaren Ergebnissen. „Dateiwerkstatt“ bezeichnet die Gestaltungsrichtung; der bestehende Produktname bleibt erhalten. Die vier Werkzeuge und sieben vorhandenen Seiten bleiben unter ihren URLs verfügbar. Es entstehen keine zusätzlichen Werkzeuge, Vorschauen, Sammeldownloads, Konten, neuen Bibliotheken oder externen Schrift-/Bildquellen.

Die Startseite beginnt mit der kompakten sichtbaren H1 „Werkzeuge“ und vier gleichrangigen Aufgabenfeldern. Kein großer Hero, keine Einleitungstextwand und kein Abschnitt „So funktioniert es“. Die Hauptaufgabe ist unmittelbar erreichbar.

## Seitenrahmen und Navigation

- Der vorhandene Werkzeugkatalog `src/data/tools.ts` bleibt die einzige Quelle für Titel, Links und Verfügbarkeit. Die Kategorien Bilder und PDF dienen der Orientierung; keines der vier Werkzeuge wird als bevorzugtes Produkt hervorgehoben.
- Auf breiten Ansichten erhält der gemeinsame Seitenrahmen eine schmale Werkzeugnavigation mit aktiver Route, Produktkennung und Informationslink. Hauptinhalt und Navigation dürfen zusammen höchstens die verfügbare Breite beanspruchen. Richtwert: Navigation 208–232 px, äußerer Seitenabstand 24–40 px, Inhaltsbreite höchstens etwa 1440 px.
- Unterhalb einer passenden Desktopbreite von etwa 1024 px wird die Werkzeugnavigation kompakt oberhalb des Inhalts angeboten. Werkzeuglinks müssen mit Touch und Tastatur erreichbar sein. Wenn ein aufklappbarer Bereich verwendet wird, braucht er einen beschrifteten Button mit `aria-expanded`, Escape und verlässlichem Fokus; die Links müssen ohne JavaScript auffindbar bleiben.
- Werkzeugseiten haben genau eine sichtbare H1 mit kurzem aufgabenbezogenem Beschreibungssatz. Die URL wird zur Bestimmung der aktiven Seite verwendet. Das Informationsziel `/lokale-verarbeitung` bleibt kompatibel erreichbar, beschreibt jedoch den aktuellen Serverbetrieb.
- Skiplink, `main#inhalt`, sinnvolle Landmarken, deutsche Seitentitel und No-JS-Hinweis bleiben erhalten. Der Footer enthält Werkzeug- und Informationslinks; keine erfundenen Betreiber- oder Rechtstexte.

Die Navigation darf im Header oder in einer gemeinsamen Rahmenstruktur umgesetzt werden. Die Präsentation bleibt von `useImageBatch`, API-Client und Sicherheitsvertrag getrennt. Semantische vorhandene CSS-Klassen werden weiterverwendet; eine Umstrukturierung des API-/Hook-Lebenszyklus ist kein Gestaltungsziel.

## Arbeitsbereich

Alle vier Werkzeuge folgen der sichtbaren Reihenfolge **Auswahl → Einstellungen → Start → Ergebnisse**. Das entspricht zugleich der DOM- und Tastaturreihenfolge. Bei PDF ersetzen Analyse und Variantenvergleich die Bildoptionen. Eine rein darstellende gemeinsame Komponente ist erlaubt, wenn sie tatsächlich wiederholtes Layout vereinheitlicht; sie besitzt keinen neuen Upload- oder Jobzustand.

- Desktop: flexibler Auswahl-/Ergebnisbereich und 320–360 px breiter Einstellungsbereich. Beide Spalten brauchen `min-width: 0`; lange Dateinamen brechen um. Gemeinsame Abschnittsüberschriften und dieselbe Hierarchie ersetzen die derzeit unterschiedlichen Werkzeugeindrücke.
- Mobil: alle Bereiche stehen linear untereinander. Keine notwendige horizontale Scrollfläche bei 320 px. Keine schwebende Startaktion, die Ergebnisse oder Tastaturfokus verdeckt.
- Einstellungen und tatsächliche Aktion sind klar verbunden. Der Startbutton benennt die Aufgabe und, soweit bereits vorhanden, die Anzahl. Eine deaktivierte Aktion erhält einen verständlichen Grund. „Zurücksetzen“, Entfernen und Abbrechen bleiben eindeutig von Start unterscheidbar.
- Upload-/Speicherhinweis ist vor Start sichtbar. Dateiauswahl löst keinen Upload und keine heimliche lokale Ersatzverarbeitung aus. Die bestehende lokale Eingabeprüfung darf vor dem ausdrücklichen Start laufen.
- Wenn Einstellungen nach einer fertigen Ausgabe geändert werden, bleibt diese als Ergebnis der vorherigen Einstellungen erkennbar. Ein alter Download darf nicht den Eindruck einer neuen Berechnung erhalten.

## Visuelle Grundlagen

Bestehende Systemschriften bleiben erhalten. Fließtext und Formulare verwenden 16 px; kompakte Hinweise mindestens 14 px. H1: 28–36 px, Abschnittstitel: 18–22 px. Dateigrößen und Maße verwenden tabellarische Ziffern. Zeilenhöhen liegen ungefähr bei 1,45–1,6.

Die Abstände folgen einer kleinen zentralen Skala: 4, 8, 12, 16, 24, 32 und 48 px. Kontrollen erhalten 8–12 px, Panels 12–16 px Radius. Konturen und Flächen strukturieren den Inhalt; Schatten bleiben überwiegend Menüs und Überlagerungen vorbehalten. Touchziele sollen mindestens 44 px hoch sein; kompakte Bedienelemente brauchen ausreichenden Abstand.

| Semantik | Hell | Dunkel |
| --- | --- | --- |
| Seitenpapier | `#F6F4EF` | `#101918` |
| Arbeitsfläche | `#FFFFFF` | `#182623` |
| Haupttext | `#172B2A` | `#DDEAE5` |
| Nebentext | `#526461` | `#A9BBB4` |
| Hauptaktion | `#0F6B61` | `#80D5BC` |
| Text auf Hauptaktion | `#FFFFFF` | `#10221D` |
| Informationsfläche | `#E4F0EC` | abgestufte dunkelgrüne Fläche mit geprüftem Textkontrast |
| erforderliche Kontrollkontur | `#647F77` | `#91B8AB` |

Der Fokus erhält eine klar sichtbare Kontur mit Abstand; er darf weder durch Panels noch durch Sticky-Elemente verdeckt werden. Fehler und Warnung benötigen zusätzlich zu Farbe verständlichen Text und gegebenenfalls ein Symbol. Für fehlerhafte Felder gelten Beschriftung, `aria-invalid` und zugeordneter Fehlertext. Disabled-Zustände dürfen nicht wie verfügbare Aktionen wirken, müssen aber lesbar bleiben.

Die obigen Kernpaare wurden rechnerisch nach relativer sRGB-Luminanz geprüft: Haupttext/Papier 13,50:1, Nebentext/Papier 5,70:1, Weiß/Hauptaktion 6,37:1; im Dunkelmodus Haupttext/Arbeitsfläche 12,66:1, Nebentext/Arbeitsfläche 7,80:1 und Text/Hauptaktion 9,59:1. Kontrollkontur/Arbeitsfläche: hell 4,34:1, dunkel 7,20:1. Das ist ein Token-Nachweis, keine vorweggenommene Abnahme aller gerenderten Zustände. Hover, Fokus, Fehlermeldungen und weitere Flächen werden in der Umsetzung gesondert geprüft.

Bewegung unterstützt höchstens Zustandswechsel; `prefers-reduced-motion` reduziert sie. Fortschritt und Erfolg werden nicht durch dekorative Animation vorgetäuscht. Die bestehende CSP gilt weiterhin: keine neuen fremden Quellen und keine unzulässigen Inline-Styles.

## Zustandsvertrag

| Zustand | Sichtbare Information und Aktion |
| --- | --- |
| Leer | Geeignete Dateitypen und serverseitig gelieferte Grenzen; beschriftete Dateiauswahl und Dropmöglichkeit. |
| Prüfung | Datei wird geprüft; Start ist entsprechend begründet gesperrt. |
| Bereit | Dateiname, reale Eingangsgröße und verfügbare Maße; Einstellungen und Start erreichbar. |
| Upload | Wahrheitsgemäßer Uploadstatus; kein erfundener Fortschrittsbalken. |
| Queue | „Wartet auf Verarbeitung“ oder gleichwertiger deutscher Text; keine unbelegte Queueposition. |
| Verarbeitung | Tatsächlicher Serverstatus und nur gelieferte Fortschrittswerte; vorhandene Abbruchmöglichkeit erhalten. |
| Erfolg | Original und Ergebnis klar zugeordnet; reale Größe, Maße, Änderung und Download samt Ablauf. |
| Teilfehler | Jeder Fehler gehört zur betroffenen Datei/Variante; erfolgreiche Downloads bleiben verfügbar. |
| Fehler/Serverausfall | Verständlicher deutscher Grund; vorhandene Wiederholungsmöglichkeit ohne stillen Upload-Retry. |
| Abgelaufen | Ergebnis als abgelaufen kennzeichnen; keine weiterhin gültig wirkenden Downloadlinks. |
| Entfernt/Reset | Fokus sinnvoll zurückführen; verspätete Serverantworten dürfen alte Einträge nicht wiederherstellen. |

Live-Regionen melden relevante Änderungen ohne redundante fortlaufende Ansagen. Status ist auch ohne Farbwahrnehmung verständlich. Die bestehenden Hooks und Clientverträge sind die Quelle für echte Zustände; ein reproduzierter Lebenszyklusfehler erfordert einen gezielten Regressionstest statt einer visuellen Kaschierung.

## Funktionsparität und Prüfinventar

| Werkzeug/Vertrag | Zu erhalten | Bestehende Prüfanker |
| --- | --- | --- |
| Bilder konvertieren | Unterstützte JPEG-, PNG-, WebP-, BMP- und ICO-Ausgaben gemäß Server-Capabilities, wirksame Qualitäts-/Hintergrundoptionen, ICO-Größen, Batch und unveränderte Abmessungen außerhalb des ICO-Vertrags. | `ImageConverter.tsx`, `formats.ts`, `options.tsx`, `useImageBatch.ts`, `e2e/convert.spec.ts`. |
| Bilder komprimieren | Verfügbare JPEG-/WebP-/PNG-Ausgaben, Qualität soweit wirksam, Hintergrund, optionale maximale Kante ohne Vergrößern, ehrlicher PNG-Hinweis und Batch. | `ImageCompressor.tsx`, `e2e/compress.spec.ts`. |
| Bilder skalieren | Prozent oder Breite/Höhe, Seitenverhältnis, ausdrückliche Upscale-Erlaubnis, Zielformat/„Wie Original“, Server-Capabilities und Sperre nicht ausgabefähiger Originalformate. | `ImageResizer.tsx`, `e2e/resize.spec.ts`. |
| PDF komprimieren | Genau eine PDF, bestehende Analysefelder und drei tatsächlich berechnete Varianten, Signatur-/Verschlüsselungshinweise, echter Fortschritt, Teilfehler, Abbruch und Ablauf. | `PdfCompressor.tsx`, `e2e/pdf.spec.ts`, `e2e/server-errors.spec.ts`. |
| Gemeinsamer Lebenszyklus | Vor Start kein Upload, Sitzung/CSRF/Same-Origin, Löschen/Reset/Abbruch, keine persistierten Dateien in Browserstorage und keine stille lokale Ersatzverarbeitung. | `src/lib/api`, `useImageBatch.ts`, `e2e/privacy.spec.ts`, `e2e/server-errors.spec.ts`. |
| Zugänglichkeit und Navigation | Vier direkte Werkzeuglinks, Alt-URL, No-JS-Informationszugang, Tastatur, Fokus, hell/dunkel und reduzierte Bewegung. | `e2e/home.spec.ts`, `navigation.spec.ts`, `site.spec.ts`, `accessibility.spec.ts`. |

Eingaben JPEG, PNG, WebP, GIF, BMP, ICO und AVIF werden nach aktuellem Vertrag geprüft; angebotene Ausgaben richten sich nach realen Capabilities. Grenzfälle: 30/31 Dateien, gleiche Namen, ungültige Signatur, Animation, Datei-/Pixel-/Kantenlimit, Alpha/Hintergrund und ICO-Größen. Keine neuen Zahlenlimits unabhängig vom Serververtrag einführen.

Beim Resizer gehören Einzel- und Doppelkante, Verhältnis an/aus, Prozent, Upscale und Originalformatsperren zur Matrix. PDF braucht beschädigte, verschlüsselte und unverkleinerbare Eingaben. Netzunterbrechung, 429/Retry-After und 5xx müssen nachvollziehbare Meldungen liefern. Größere oder unveränderte Ergebnisse sind gültige Ergebnisse und dürfen keine erfundene Ersparnis zeigen.

## Abnahmekriterien und Beweisgrenzen

1. Alle vier Aufgaben bleiben unter ihren bestehenden URLs vollständig bedienbar; sämtliche vorher verfügbaren Optionen und Lebenszyklusaktionen erhalten.
2. Alle sieben Seiten werden bei 320/390/768/1440 px, hell/dunkel, Tastatur, 200 % Zoom und reduzierter Bewegung visuell geprüft. Lange Dateinamen und große Stapel verdecken keine erforderlichen Inhalte.
3. Text erreicht mindestens 4,5:1, große Schrift 3:1, erforderliche Kontroll-/Fokuskontraste 3:1. Axe wird mindestens für leere, fertige und fehlerhafte Zustände eingesetzt; keine pauschale Regeldeaktivierung.
4. `npm run check`, `npm test`, `npm run build`, API-Typencheck und die Playwright-Projekte Chromium, Firefox, WebKit und mobile liefern belegte Ergebnisse. Ein Timeout bleibt ein offener Nachweis.
5. Mocktests und statische Preview beweisen keine echte Dateiverarbeitung. Linux-Race-/Sandbox-/DB-/Valkey-/Fullstackprüfungen und vier reale Dateiaufgaben werden getrennt dokumentiert. Ein fehlender Linux-Daemon verhindert die Behauptung vollständiger technischer Abnahme.
6. Ein unabhängiger Funktions-/Gestaltungsreview und ein eigener Infrastrukturreview behandeln bestätigte relevante Befunde. Nicht ausgeführte GitHub-CI und fehlende Betreiber-/Rechtstexte werden als solche benannt.

Nach erfüllten Kriterien endet die Umsetzung. Kein Merge, Push, Deployment, Nutzdaten-/Volumenlöschen oder zusätzlicher Infrastrukturumbau ohne Auftrag.
