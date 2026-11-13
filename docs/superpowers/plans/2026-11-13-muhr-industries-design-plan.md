# Plan: Design im Stil von muhrindustries.com

**Stand:** 13.11.2026. **Branch:** `design/muhr-industries` (von `origin/main` `0d35657`, nicht gestapelt auf PR #1). **Worktree:** `../converter-design`.

## Ziel

Der Converter übernimmt die Gestaltung von muhrindustries.com: dunkle, ruhige Flächen mit Mint-Akzent, Haarlinien, Karten mit Akzentkante, Pill-Navigation. Funktion, Texte, API und Tests bleiben unverändert. Dunkel ist Standard, zusätzlich gibt es eine helle Variante.

## Nicht-Ziele

- Keine Änderungen an Werkzeuglogik, Texten, Seitenstruktur, API oder CSP-Direktiven.
- Keine externen Schriften, Skripte oder Bilder (CSP `font-src 'self'`, kein CDN). Kein Sternenhimmel/Three.js.
- Keine Übernahme von Logo, Inhalten oder Cookie-Banner der Referenzseite.

## Bekannte Folge

PR #1 (`redesign/file-workshop`) baut `global.css`, Header und Komponenten um. Beim späteren Zusammenführen sind Konflikte zu erwarten. Vom Nutzer so entschieden.

## Referenz-Tokens (aus dem CSS von muhrindustries.com)

| Token | Wert |
| --- | --- |
| `--mi-canvas` | `#070b0d` |
| `--mi-parchment` / `--mi-tile-1` | `#0b1214` |
| `--mi-tile-2` | `#0e1719` |
| `--mi-pearl` | `#10191b` |
| `--mi-hairline` | `#ffffff1a` |
| `--mi-divider-soft` | `#ffffff12` |
| `--mi-ink` | `#f5fbfa` |
| `--mi-ink-80` | `#b8c9c6` |
| `--mi-body-muted` | `#a9bbb7` |
| `--mi-ink-48` | `#7f9490` |
| `--mi-primary` | `#5eead4` |
| `--mi-primary-hover` | `#2dd4bf` |
| Text auf Primary | `#06110f` |

Komponenten der Referenz:

- `.mi-btn`: `border-radius:12px; padding:11px 22px; font-size:1.0625rem; letter-spacing:-.022em`; `.mi-btn-sm`: `padding:7px 15px; font-size:.875rem`.
- `.mi-btn-primary`: Hintergrund Primary, Text `#06110f`; `.mi-btn-secondary`: transparent, 1px Rand und Text in Primary.
- `.mi-card`: `border:1px solid hairline; border-top:2px solid #5eead480; border-radius:14px; padding:24px; background:linear-gradient(145deg,#ffffff0b,#ffffff05)`.
- Typo: `.mi-hero` `clamp(2.25rem,5vw,3.5rem)/1.07`, 600, `-.01em`; `.mi-display-md` `clamp(1.625rem,3vw,2.125rem)/1.2`, 600; `.mi-lead-airy` `clamp(1.125rem,1.8vw,1.5rem)/1.5`, 300; `.mi-body` `1.0625rem/1.44`, `-.022em`; `.mi-caption` `.875rem/1.43`.
- Schrift: System-Stack `-apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", sans-serif`. Der vorhandene System-Stack bleibt, es werden keine Schriftdateien geladen.
- Header: dunkle Leiste mit Haarlinie unten; Navigation zentriert, aktiver Eintrag als Pill (`#ffffff14`-Fläche, Radius ~8px, fett); CTA rechts als kleiner Primary-Button.
- Kleine Überzeile (Eyebrow) über Hero-Titeln in `ink-48`/`muted`, Titel zentriert bzw. linksbündig groß.

## Architektur-Entscheidungen

1. **Tokens bleiben die Schnittstelle.** Komponenten nutzen weiter die Klassen und `--color-*`-Tokens aus `src/styles/global.css` (`bg-surface`, `text-muted`, `.btn-primary`, `.card` …). Nur Werte und Komponentenstile ändern sich, Klassennamen und Markup der Werkzeuge möglichst nicht.
2. **Theme-Umschaltung:** `@theme` enthält die **dunklen** Werte als Standard. Die helle Variante überschreibt dieselben Variablen unter `:root[data-theme="light"]`. `prefers-color-scheme` wird nicht mehr zur Auswahl verwendet (Dunkel ist Standard).
3. **Umschalter:** Button im Header (`aria-pressed`, zugängliches Label „Helles Design“/„Dunkles Design“). Speichert die Wahl **nur nach Klick** in `localStorage` unter `mi-theme`. Ein kleines Inline-Skript im `<head>` setzt `data-theme` vor dem ersten Paint. Es muss mit der CSP funktionieren (Astro-CSP hasht Skripte; per Build und e2e prüfen, dass keine `securitypolicyviolation` auftritt). Ohne JavaScript: dunkel.
4. **Helle Palette** (Vorschlag, an WCAG anpassen): canvas `#f5fbfa`, surface `#ffffff`, surface-muted `#eef5f4`, ink `#070b0d`, muted `#4d5f5b`, Links/Akzenttext `#0f766e`, Button-Füllung weiterhin `#5eead4`/Hover `#2dd4bf` mit Text `#06110f`, Haarlinie `#0000001a`.
5. **Kontraste:** Die Kontrasttabelle im Kopf von `global.css` wird für beide Themes neu berechnet und aktualisiert. Mindestwerte: Text ≥ 4,5:1, Bedienelement-Ränder und Fokus ≥ 3:1. Haarlinien bleiben dekorativ; Eingabefelder brauchen einen eigenen `border-control` mit ≥ 3:1.
6. **Meta:** `theme-color` auf `#070b0d` (dunkel), `color-scheme` passend zum aktiven Theme.

## Aufgaben (sequenziell, je ein Implementierer-Subagent, danach unabhängiger Review)

### A. Tokens und Theme-Mechanik

Dateien: `src/styles/global.css` (Token-Block, Dark-Media-Block ersetzen), `src/layouts/BaseLayout.astro`, `src/components/site/SiteHeader.astro` (Umschalter).

- Dunkle Werte aus der Referenztabelle auf die vorhandenen `--color-*`-Tokens abbilden (canvas, surface, surface-muted, fill, fill-hover, segment, border, border-strong, border-control, ink, muted, accent*, on-accent, focus, success/warning/danger inkl. soft, header, header-solid, panel). Radien: `--radius-control: 12px`, `--radius-card: 14px`. Schatten an dunkle Flächen anpassen.
- Helle Variante unter `:root[data-theme="light"]`.
- Head-Skript, Umschalter, Meta-Tags.
- Kontrasttabelle aktualisieren (rechnerisch prüfen, z. B. mit kleinem Node-Skript in einem Temp-Verzeichnis, nicht committen).
- Commit: `style(theme): Muhr-Industries-Farbtokens mit dunklem Standard und heller Variante`.

### B. Komponentenstile

Dateien: `src/styles/global.css` (Komponentenklassen), `SiteHeader.astro`, `SiteFooter.astro`, `src/pages/index.astro` nur falls für Hero/Karten-Klassen nötig.

- `.btn*` nach `.mi-btn`, `.mi-btn-primary`, `.mi-btn-secondary`, `.mi-btn-sm`.
- `.card`, `.card-link`, `.variant-card`, `.drop-zone`, `.file-row`, `.notice*`, `.badge*`, Felder/Selects/Range im Stil der Referenz (Haarlinien, dunkle Flächen, Mint-Fokus).
- Typo: `.hero-title`/`.page-title` nach `.mi-hero`, `.section-title` nach `.mi-display-md`, `.hero-lead`/`.page-lead` nach `.mi-lead-airy`, `.page-eyebrow`/`.section-kicker` als Eyebrow.
- Header: Pill-Navigation für den aktiven Eintrag, Haarlinie unten, halbtransparenter dunkler Hintergrund mit Blur. Footer: Haarlinie oben, gedämpfter Text.
- Fokus, Disabled, Hover, `prefers-reduced-motion` erhalten.
- Commit: `style(ui): Komponenten im Muhr-Industries-Stil`.

### C. Abnahme

- `npm run check`, `npm test`, `npm run build`, `npx playwright test` (vor allem `accessibility.spec.ts` mit axe-Kontrastprüfung und `privacy.spec.ts`: keine CSP-Verletzung, kein Storage-Zugriff ohne Klick).
- Screenshots von Startseite und einem Werkzeug je Theme bei 1440 und 390 px gegen die Referenz-Screenshots.
- Unabhängiger Review-Subagent prüft Diff gegen diesen Plan.
- Fehlschläge werden berichtet, nicht stillschweigend weggelassen. Bestehende Tests nicht abschwächen; falls ein Test an Farbwerten hängt, nur mit Begründung anpassen.
