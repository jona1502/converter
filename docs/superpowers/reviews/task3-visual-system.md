# Punkt 3 – gemeinsames visuelles System

Stand: 03.11.2026. Verantwortlicher Implementierer: `visual_system`. Ausgangsbasis: `3608af7a8cfbd01ae4504d6514fbf469fc768eff`. Umfang: ausschließlich `src/styles/global.css`, `src/layouts/BaseLayout.astro`, `public/favicon.svg` und diese Nachweise. Keine Werkzeuglogik, Navigation, Kopie oder URL geändert. Markenname **MI converter** bleibt erhalten; Dateiwerkstatt bezeichnet die freigegebene Gestaltung.

## Ergebnis und Schnittstellen

Warme Papierflächen und Petrol ersetzen die blaue, schwebende Gestaltung. Helle/dunkle Farbpaare, Systemschriften, eine kleine Abstandsskala, Kontrollradius 10 px und Panelradius 16 px sind zentral definiert. Body/Formulare 16 px, Hinweise/Badges mindestens 14 px, Seitentitel 28–36 px und Abschnittstitel 18–22 px. Karten haben Konturen; Schatten sind für Menüs reserviert. Buttons und Segmentlabels bleiben mindestens 44 px hoch, Symbolbuttons mindestens 44 px breit. Die Seitenabstände wurden kompakter, Theme-Metadaten und lokales SVG-Favicon folgen der Palette.

Alle bisherigen Token- und semantischen Klassennamen bleiben erhalten. Die Selektoren für Disabled/ARIA-disabled, checked, invalid, dragging, disabled Dropzone, Dateistatus und bestimmtes/unbestimmtes progress bleiben bestehen. Fokus hat 3 px Kontur und 3 px Abstand; die Dateiliste schneidet ihn nicht mehr per overflow ab. Dark Mode und reduced-motion bleiben reine Medienabfragen. Keine externe Schrift, Bibliothek, Netzquelle oder Inline-Styles hinzugefügt. Historische Kommentare wurden erhalten; die veraltete Kontrast-/Formbeschreibung erhielt einen datierten Korrekturkommentar.

## Kontrastnachweis

Berechnung direkt aus den finalen `--color-*`-Hexwerten: sRGB-Kanäle durch 255 teilen; bis 0,04045 durch 12,92 teilen, sonst `((c+0,055)/1,055)^2,4`; Luminanz `0,2126R+0,7152G+0,0722B`; Verhältnis `(Lhell+0,05)/(Ldunkel+0,05)`. Geprüft wurden ink auf canvas/surface/surface-muted/fill/fill-hover/segment und allen Statusflächen; muted auf canvas/surface/surface-muted und Statusflächen; Akzentlinks, beide Hauptaktionszustände, Statusfarben sowie Fokus/Kontrollkonturen. Das ist ein Tokenbeweis, kein Ersatz für die spätere gerenderte Zustandsmatrix.

| Paar | Hell | Dunkel |
| --- | --- | --- |
| Haupttext/Papier | 13,50:1 | 14,46:1 |
| Haupttext/Arbeitsfläche | 14,84:1 | 12,66:1 |
| Nebentext/Papier | 5,70:1 | 8,90:1 |
| Nebentext/Arbeitsfläche | 6,26:1 | 7,80:1 |
| Hauptaktion Text/Fläche | 6,37:1 | 9,59:1 |
| Hauptaktion Text/Hover | 8,66:1 | 11,51:1 |
| Akzent/Informationsfläche | 5,45:1 | 7,12:1 |
| Erfolg/Erfolgsfläche | 6,17:1 | 7,13:1 |
| Warnung/Warnfläche | 5,75:1 | 8,16:1 |
| Fehler/Fehlerfläche | 5,39:1 | 7,44:1 |
| Fokus/Arbeitsfläche | 6,37:1 | 9,07:1 |
| Kontrollkontur/Arbeitsfläche | 4,34:1 | 7,20:1 |
| Kontrollkontur/surface-muted | 3,94:1 | 6,05:1 |

Niedrigste geprüfte aktive Textkombination: hell 5,36:1, dunkel 5,92:1. Gewählte deaktivierte Segmente setzen ihre Fläche auf surface-muted zurück, sodass der gedämpfte Text im Dark Mode lesbar bleibt. Dekorative Panelränder sind keine erforderlichen Kontrollkonturen.

## Tatsächliche Prüfungen

- `npm run check` nach Tokens, Controls und Shell: jeweils 96 Dateien, 0 Fehler, 0 Warnungen, 0 Hinweise.
- `npm run build` nach Tokens und Controls: sieben Seiten, Exit 0. Der abschließende Playwright-Webserver baut die Shell erneut erfolgreich, bevor Tests starten.
- `npx playwright test e2e/home.spec.ts e2e/site.spec.ts --project=chromium`: nach Controls und nach Shell jeweils **12 bestanden**. Abschließender Lauf 8,0 s, Exit 0. Prüft insbesondere deutsche Metadaten, direkte Links, CSP/keine Fremdanfragen/keine Inline-Styles, Skiplink/Fokus, Footer-Tastaturweg und 320-px-Overflow für Start-/Info-/404-Seite.
- `AxeBuilder` aus dem vorhandenen `@axe-core/playwright`, Tags wcag2a/wcag2aa/wcag21aa ohne deaktivierte Regeln: Startseite in Chromium hell und dunkel gegen statische Preview auf Port 4331, **jeweils 0 Verstöße**, Exit 0. Keine Verarbeitung vorgetäuscht.
- `git diff --check`: ohne Fehler. Git meldet lediglich die vorhandene CRLF-zu-LF-Normalisierung.

Keine CSS spiegelnden Unit-Tests ergänzt. Die vollständigen Vitest-/Browser-/Realdatei-Läufe erfolgen nach den nachfolgenden Komponentenarbeiten im Gesamtgate. Die bestehende nach-Verarbeitung-Axe-Suite, leere/fehlerhafte Werkzeugzustände, vier Browserprofile und die komplette manuelle visuelle Matrix sind durch diesen engen Task3-Nachweis nicht abgenommen. Ein unabhängiger Task3-Review folgt über Root.

## Teilcommits

| Teil | Commit | Inhalt |
| --- | --- | --- |
| 3a | `40338c5` | Hell-/Dunkel-Tokens, Abstände, Radien, zurückhaltende Schatten und datierte Kontrastkorrektur. |
| 3b | `c5a456a` | Gemeinsame Controls, Typografie, Zustände und Fokusgestaltung. |
| 3c | Einführungscommit dieses Berichts; `git log -1 --format=%H -- src/layouts/BaseLayout.astro` liefert die feste ID. | Kompakte Shell, Theme-Metadaten, Favicon sowie Preflight und tatsächliche Nachweise. Die ID wird im nächsten ohnehin nötigen Ledgerupdate ergänzt. |
