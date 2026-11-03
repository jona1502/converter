# Frontend-Preflight – Dateiwerkstatt

Stand: 03.11.2026. Quellenprüfung vor Umsetzung; keine Produktänderung, kein Commit und keine Tests in diesem Preflight ausgeführt. Der gespeicherte Auditplan ist noch als vorläufig markiert; Root hält die inzwischen erteilte Freigabe und die neue Untercommit-Regel in der Spezifikation fest. Beim Lesen gab es keine `AGENTS.md` im Repository oder den untersuchten Elternverzeichnissen. Git meldete nur `?? docs/superpowers/`.

## Workflow und Grenzen

Sites-Skill gelesen: `C:/Users/muhr9/.codex/plugins/cache/openai-curated-remote/sites/1.1.2/skills/sites/SKILL.md`. Für dieses vorhandene lokale Astro-Repository gilt der Abschnitt **Local-only**: vorhandenen Checkout verwenden, direkte Checks/Builds; keine Registrierung, Source-Synchronisierung, Packaging oder Veröffentlichung. Kein Starter, Hostingmanifest, neue Bibliothek oder externe Schrift erforderlich. Lokale Preview folgt `references/preview/local.md`; Playwright ist bereits eingerichtet. Kein Hero, keine Einleitungstextwand, kein „So funktioniert es“.

## CSS-Schnittstelle für Punkt 3

`src/styles/global.css:25` ist Tailwind-v4-`@theme`. Bestehende Namen erhalten, damit direkte Utilities und Astro-Scoped-CSS mitziehen:

- Schriften: `font-sans`, `font-display`, `font-mono`, ausschließlich Systemstacks.
- Flächen: `canvas`, `surface`, `surface-muted`, `fill`, `fill-hover`, `segment`, `header`, `header-solid`, `panel`.
- Kontrast: `ink`, `muted`, `border`, `border-strong`, `border-control`, `focus`.
- Akzent: `accent`, `accent-hover`, `accent-fill`, `accent-fill-hover`, `accent-soft`, `on-accent`.
- Status: `success`, `warning`, `danger`, jeweils `*-soft`; `radius-control`, `radius-card`; `shadow-card`, `shadow-lift`, `shadow-panel`.
- Dunkle Werte werden unter `@media (prefers-color-scheme: dark)` auf `:root` überschrieben. Kein neuer Themezustand nötig.

Semantische Klassen sind die Integrationsschnittstelle, nicht umzubenennen:

- Layout: `page-container`, `page-container-narrow`, `page-section`, `page-eyebrow`, `page-title`, `page-lead`, `section-title`, `section-kicker`, `prose-content`, `link`, `link-standalone`, `skip-link`. Vorhandene `hero*`-Definitionen müssen auf der Startseite unbenutzt bleiben.
- Aktionen: `btn` plus `btn-primary|secondary|danger|ghost`, `btn-sm|lg|icon`. Native `disabled` und `[aria-disabled=true]` getrennt von aktiven Hoverzuständen erhalten; kein Farb-Transition auf Buttons (bestehender axe-Hinweis).
- Flächen: `card`, `card-muted`, `card-link`, `card-title`, `card-icon`.
- Eingaben: `field`, `field-row`, `label`, `hint`, `field-error`, `input`, `select`, `range`, `checkbox`, `radio`, `color-input`, `fieldset`, `legend`, `choice-group`. `choice-group > label:has(input:checked|disabled)` und `[aria-invalid=true]` erhalten.
- Hinweise: `notice`, `notice-info|warn|error|success`, `notice-title`; Badges: `badge`, `badge-neutral|accent|success|warn|danger`.
- Werkzeuge: `drop-zone[data-dragging=true][data-disabled=true]` (jeweils separate Zustände), `file-list`, `file-row[data-status]`, `file-name`, `file-result`, `meta-list` mit `div/dt/dd`, `progress` bestimmt/unbestimmt, `variant-card`, `variant-size`.

Alle Tokenfarben neu berechnen; bestehender Kontrastkommentar ist nur für die alte Palette gültig. Text 4,5:1, große Schrift 3:1, Kontrolle/Fokus 3:1. `border` ist dekorativ; `border-control` macht Eingaben erkennbar. Reduzierte Bewegung und sichtbaren Tastaturfokus erhalten. `file-name` ist aktuell `truncate` + vollständiger `title`; Umbruch und mobile Zeilenanordnung gehören gezielt zu Punkt 6. Der aktuelle Dateikopf hat Badge und Entfernen-Button mit `shrink-0`; das ist ein besonderer 320-px-Prüfpunkt.

## Punkt 3 in drei sichere Untercommits

1. **`style: define file workshop foundation tokens`** – nur `global.css`: freigegebene helle/dunkle Farbwerte, Schrift-/Abstands-/Radius-/Schattenbasis, Kontrastdokumentation. Existierende Namen erhalten. `npm run check`, `npm run build`, rechnerische Kontrastprüfung dokumentieren.
2. **`style: restyle shared workshop controls and states`** – nur `global.css`: Buttons, Karten, Eingaben, Hinweise, Badges, Dropzone, Fortschritt und Ergebnisse auf neue Formensprache bringen; alle Zustandselektoren erhalten. Erneut Check/Build nach dem CSS-Schritt, fokussierte bestehende Browser-/axe-Prüfung mit benannter Laufumgebung. Keine CSS spiegelnden Unit-Tests.
3. **`style: align workshop page shell and identity`** – `BaseLayout.astro`, freigegebenes `public/favicon.svg`, minimale markenbezogene Erwartungsanpassung in `e2e/home.spec.ts`: `SITE_NAME`, Theme-Metadaten und kompakte Seitenabstände. `lang=de`, Meta-Description/Referrer/Noindex, Skiplink, `main#inhalt[tabindex=-1]`, No-JS-Hinweis erhalten. Neuer Name ändert Header und Footer automatisch via Props. Die Erwartung `/– MI converter$/` muss atomar zur Umbenennung auf Dateiwerkstatt wechseln. Check/Build plus Home/Site-Browserfälle; keine neue Bild-/Fontanfrage.

Aktuell setzt BaseLayout große Abstände (`pt-10 sm:pt-16`, `pb-20 sm:pb-28`). Ein kompakter Rahmen darf die sichtbaren Optionen nicht zusammenpressen. `html` hat `scroll-padding-top:7rem` für die sticky Navigation; bei neuer Headerhöhe passend bestätigen. `astro.config.mjs` erzeugt CSP-Meta, verbietet fremde Quellen und Inline-Styles; Styling in CSS/Stylesheet statt `style`-Attributen.

## Punkt 4: Navigation und direkte Startauswahl

Sicherster Ansatz: die drei bestehenden nativen `details/summary`-Gruppen **Konvertieren, Komprimieren, Skalieren** gestalterisch umbauen, Daten und Verhalten erhalten. `src/data/tools.ts` bleibt einzige Werkzeugquelle; Kategorien Bilder/PDF und alle vier vorhandenen Hrefs erhalten. Desktop darf kompakter wirken; mobil zweizeilige Kopfzeile mit eigener vollbreiter Navigation und Panelbreite vom verfügbaren Container, `min-width:0`, Umbruch für lange Beschriftungen. Keine feste Mindestbreite und kein horizontales Scrollmenü.

Das bestehende Skript in `SiteHeader.astro:87` deckt Mouse-Hover, ersten Klick nach Hover, Touchtoggle, nur ein offenes Menü, Fokusverlust, Escape mit Rückfokus und Außenklick ab. Es hängt an `.tool-navigation`, `.nav-dropdown` und `summary`; diese Selektoren erhalten oder Skript und Tests im selben Commit migrieren. Native Details bleiben ohne JS verwendbar. Ein Ersatz durch direkte Links ist möglich, würde aber fast alle Navigationstests und die bisherigen Menüfälle verändern; für diesen Redesignschritt ist die Beibehaltung enger begrenzt.

Startseite: bestehendes `section[aria-labelledby=werkzeuge]`, H1 `#werkzeuge` mit Text **Dateien bearbeiten** sichtbar und kompakt gestalten, `sr-only` entfernen. Kategorien und vier volle Kartenlinks direkt darunter; keine zusätzliche Hero-/Anleitungsstrecke. `a.card-link` und leeren Kataloghinweis erhalten. Footer hat das eigenständige Navigationlabel **Fußzeile**, Link **Dateiverarbeitung** per `aria-label`, aktive Informationsseite und korrekten temporären Upload-/Löschhinweis; diese Verträge erhalten.

Empfohlene drei Untercommits: Header/Dropdowngestaltung plus passende Navigationstests; direkte Startauswahl plus Homefälle; Footer/Responsive-/No-JS-Abnahme plus gezielte fehlende Interaktionstests. Aktuelle Navigationstests prüfen Fokusverlust, Außenklick, No-JS und 200%-Zoom nicht ausdrücklich: diese Abnahmelücken gezielt ergänzen, keine bestehenden Tests entfernen.

## Tests und Selektoren mit Änderungsrisiko

- `e2e/home.spec.ts`: Titel endet aktuell auf `– MI converter`; sichtbare H1, keine Überschrift exakt **Werkzeuge**, keine `.hero`, kein **So funktioniert es**; `section[aria-labelledby=werkzeuge] a.card-link`; alle internen Links liefern 200.
- `e2e/navigation.spec.ts`: exakt drei `summary` in Navigation **Hauptnavigation**; feste Gruppenlabels; Links nach Titel; erste Klick-/Hoverfolge; mobiler Öffnen/Schließen-Ablauf; Escape-Rückfokus; aktive `aria-current=page`; alle vier Seiten bei 320 px. WebKit fokussiert Links programmatisch (bestehende Plattformanpassung erhalten).
- `e2e/site.spec.ts`: H1 **Dateien bearbeiten**, **Dateiverarbeitung**, **Seite nicht gefunden**; genau ein CSP-Meta; kein `[style]`, keine externen Anfragen; Skiplink **Zum Inhalt springen** zu `#inhalt` mit fokussiertem `main#inhalt`; Footerlink in höchstens 30 Tabs erreichbar; 320-px-Overflow.
- `e2e/convert.spec.ts`: **Dateien auswählen**, **Zielformat**, **Konvertieren**, **Alle entfernen**, **ICO-Größen**, **128 px**, **Hintergrundfarbe**; `.file-row`, `a[download]`, `data-testid=live-region`; Dateiremove-`aria-label` und Fokusnachfolge; geänderte Einstellungen; 31-Dateien-Limit und Reset während Verarbeitung.
- `e2e/compress.spec.ts`: **Maximale Kantenlänge (optional)**, **Qualität**, PNG-Hinweis, echte Ausgabeabmessung/-name, Einstellungenwarnung und ungültige Kante.
- `e2e/resize.spec.ts`: **Größenangabe**, **Größe in Prozent**, **Vergrößerung erlauben**, **Seitenverhältnis erhalten**, **Breite (Pixel)**, **Höhe (Pixel)**, **Zielformat**; Originalformat und gemischter Stapel, reale Abmessungen.
- `e2e/pdf.spec.ts`: **PDF-Datei**, **PDF auswählen**, **Komprimieren**, **Zurücksetzen**; genau drei Varianten **Hohe Qualität**, **Ausgewogen**, **Kleine Datei** mit eindeutigen Downloadnamen; `p.notice-error`; Reset-Rückfokus.
- `e2e/privacy.spec.ts`: alle vier Tools, `input[type=file]`, exakt beschriftete Picker/Hauptaktion, `a[download]`; POST erst nach Start, DELETE nach Reset, keine Browserstorage-/CSP-Nutzung; langer Dateiname bei 320 px, kein `[style]`. Zusätzliche externe Ressourcen würden auch die statische Pfad-Allowlist brechen.
- `e2e/accessibility.spec.ts`: axe ohne deaktivierte Regeln nach erfolgreicher Verarbeitung aller vier Tools; setzt funktionsfähige API voraus. Prüft derzeit keine leeren oder fehlerhaften Zustände und kein explizites Dunkelprofil. Zielgerichtete Ergänzung/visuelle Abnahme erforderlich, keine bloße Behauptung vollständiger Zustandsabdeckung.
- `e2e/server-errors.spec.ts` mockt API explizit und läuft gegen statische Preview; die normalen Convert/Compress/Resize/PDF/Privacy/Accessibilityfälle benötigen die echte API. `playwright.config.ts` nutzt ohne `E2E_BASE_URL` Astro-Preview auf 4329; mit URL entfällt der Webserver. Ein Previewfehler wegen fehlender API ist kein UI-Regressionsbeweis. Projekte: Chromium, Firefox, WebKit, Pixel-7-Mobile.

## Funktionsschutz für spätere Punkte

`useImageBatch`, API-Vertrag und Handler im CSS-/Navigationsschritt unangetastet lassen. Konverter: JPEG/PNG/WebP/BMP/ICO, formatabhängige Qualität/Hintergrundfarbe und ICO-Größen. Compressor: JPEG/WebP/PNG, Qualität, Hintergrund, optionale maximale Kante. Resizer: Prozent/Pixel, Einzel-/Doppelkante, Verhältnis, ausdrückliche Vergrößerung, Wie Original mit Sperren sowie JPEG/PNG/WebP/BMP, Qualität und Hintergrund nach Format. Einstellungenwarnungen nach vorhandenen Ergebnissen und unveränderte Uploadgrenze erhalten. PDF: eine Datei, drei serverberechnete Varianten, Analyse/Teilerfolge/Fehler/Ablauf/Reset/Abbruch. Keine neue Vorschau, Sammeldownloads oder automatische Qualitätsempfehlung ableiten.
