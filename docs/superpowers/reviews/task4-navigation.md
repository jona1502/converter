# Punkt 4 – Navigation, Startseite und Footer

Stand: 03.11.2026. Umsetzung auf `redesign/file-workshop` nach freigegebener Dateiwerkstatt-Spezifikation. Keine Änderung an Werkzeugzuständen, API, Uploadgrenzen oder bestehenden URLs. Ein unabhängiger Produktreview steht noch aus.

## Ergebnis

- Ab 1024 CSS-Pixeln zeigt eine 224 Pixel breite Werkzeugleiste Produktkennung, Katalog, die vier Werkzeuge nach Bilder/PDF und den Informationslink. Der Inhalt reserviert den Platz daneben.
- Darunter erschließt eine kompakte native Details-Auswahl denselben Katalog. JavaScript ergänzt `aria-expanded`, Escape mit Rückfokus, Außenklick, Fokuswechsel und Fokuskorrektur beim responsiven Wechsel. Ohne JavaScript ist die Auswahl initial geöffnet. Die bisherigen drei Operationsmenüs und ihr Hoververhalten entfallen bewusst zugunsten der freigegebenen direkten Werkzeugnavigation.
- Startseite: sichtbare H1 „Werkzeuge“, vier gleichrangige Aufgabenfelder in einem gemeinsamen Raster. Titel, URLs und Beschreibungen kommen weiterhin ausschließlich aus dem vorhandenen Werkzeugkatalog. MI converter bleibt der Produktname. Kein Hero, Einleitungstextblock oder zusätzlicher Anleitungsabschnitt.
- Footer: verständlicher Informationslink, aktive Werkzeugrouten, mindestens 44 Pixel hohe Navigationslinks, 14-Pixel-Hinweise und derselbe sachliche Hinweis auf ausdrücklichen Uploadstart, temporäre Speicherung und Ablauf.

## Tatsächliche Nachweise

| Prüfung | Ergebnis |
| --- | --- |
| Neuer mobiler Auslösertest vor Umsetzung | Erwartet rot: Auslöser fehlt |
| Chromium Navigation nach Umsetzung | 8/8 bestanden, inklusive 320 px, aktiver Routen, Tastatur, Escape, Außenklick und Fokusverlust |
| Sichtbare H1 vor Katalogänderung | Erwartet rot: Überschrift Werkzeuge fehlt |
| Chromium Home/Site nach Katalogänderung | 12/12 bestanden; interne URLs, CSP, Fremdquellen, 404, Skiplink und 320 px |
| `npm run check` | Exit 0, 98 Dateien, keine Fehler/Warnungen/Hinweise |
| `npm test` | Exit 0, 42 Dateien bestanden; 410 Tests bestanden, zehn übersprungen; 51,67 s |
| Build | Durch die erfolgreichen Playwright-Webserverläufe jeweils statischer Produktionsbuild mit sieben Seiten, Exit 0 |
| Finale gezielte Chromium-Prüfung | 2/2 bestanden: ohne JavaScript sowie Fokuskorrektur bei 1440→720 CSS-Pixeln |
| Finale gezielte WebKit-Prüfung | 7/7 bestanden: Klicknavigation, Außenklick/Fokuswechsel, vier aktive Routen bei 320 px und Zugang ohne JavaScript |

Die volle Home-/Navigation-/Site-Matrix gegen statische Preview ergab zunächst 82/88 bestanden. Vier No-JS-Fehler waren der Test-Textsuche geschuldet: Playwright ignoriert `noscript` bei `getByText`, obwohl dessen Absatz gerendert wird. Der Test nutzt jetzt den sichtbaren Absatz direkt; Chromium und WebKit bestätigen den korrigierten Ablauf. Ein WebKit-Klick deckte einen echten Fokusfehler auf: `focusout.relatedTarget === null` verbarg das Menü noch vor der Linkaktivierung. Jetzt schließt nur ein tatsächlich auf ein anderes Element wechselnder Fokus; Außenklick und Escape bleiben erhalten. Derselbe WebKit-Klicktest bestand nach dem Fix. Der sechste Matrixfehler war eine vorübergehende rohe Astro-404 auf `/`, während ein paralleler Agent denselben `dist`-Ordner neu baute; daraus wird weder ein grüner Test noch ein Produktfehler abgeleitet. Auch ein zusätzlicher Versuch gegen die inzwischen beendete Preview erhielt erwartungsgemäß Connection refused und ist kein Abnahmenachweis. Initial überlappende Testartefakte wurden durch getrennte Ausgabeordner beseitigt.

## Grenzen und Übergabe

Die volle Vier-Browser-Matrix am finalen Stand bleibt Punkt 10 vorbehalten. Das 720-CSS-Pixel-Fenster prüft dieselbe verfügbare Layoutbreite wie 1440 Pixel bei 200 Prozent Zoom; eine manuelle Browserzoom-Abnahme oder vollständige visuelle Hell-/Dunkel-Matrix wird damit nicht behauptet. Ebenso ersetzen diese statischen UI-Tests keine echte Serververarbeitung. Screenshots, vollständige gerenderte Kontrast-/Axe-Abnahme und unabhängiger Produktreview bleiben getrennte Abschlussnachweise.

Commits: `fcbb01f` Navigation, `6193d79` direkter Katalog; der dritte Commit umfasst Footer, responsive Regression, diesen Bericht und den aktualisierten Fortschrittsstand. Fremde Änderungen an Bildwerkzeugen wurden nicht gestagt. Keine Veröffentlichung, kein Merge oder Push.
