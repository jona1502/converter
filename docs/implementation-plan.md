# Umsetzungsplan – erster Release (Bildwerkzeuge)

Stand der Bestandsaufnahme (2026-10-23): Das Repository enthielt nur `README.md` und einen
Initial-Commit, keine Projektanweisungen und keinen Code. Paketmanager: keiner festgelegt → npm.

Gearbeitet wird auf dem Branch `release/v1`. Pro Arbeitspunkt entsteht genau ein Commit,
dokumentiert in [commit-log.md](commit-log.md).

## Technische Entscheidungen

| Bereich | Entscheidung | Begründung |
| --- | --- | --- |
| Framework | Astro 7.4, `output: 'static'` | statischer Build, kein Server |
| Interaktivität | React 19 über `@astrojs/react`, Inseln mit `client:load` nur auf Werkzeugseiten | Startseite und Infoseiten bleiben JS-frei |
| Styling | Tailwind CSS 4.3 über `@tailwindcss/vite` | für Tailwind v4 der von Astro dokumentierte Weg (`@astrojs/tailwind` gilt nur für v3) |
| TypeScript | 6.0 (`astro/tsconfigs/strict` + `noUncheckedIndexedAccess`) | `@astrojs/check` unterstützt TS ^5 \|\| ^6, TS 7 noch nicht |
| Bildverarbeitung | `createImageBitmap` (Orientierung `from-image`), `OffscreenCanvas.convertToBlob` im Web Worker, Rückfall auf Hauptthread-Canvas | native APIs, kein WASM nötig |
| Schrift | System-Schriftstapel | keine Font-Dateien, keine CDNs |
| Netzwerkschutz | Astro-CSP als Meta-Tag mit `connect-src 'none'` | Skripte der Seite können keine fetch/XHR/WebSocket/Beacon-Aufrufe absetzen. Dedizierte Worker erben eine Meta-CSP nicht; der Worker-Code enthält daher keine Netzwerkaufrufe. Für das Hosting werden CSP als HTTP-Header und `frame-ancestors 'none'` empfohlen (README). |
| Tests | Vitest 5 im Browser-Modus (Playwright, Chromium + Firefox + WebKit) für den Kern; Playwright für E2E gegen den Produktionsbuild (Chromium, Firefox, WebKit, mobiles Chromium) | Bildverarbeitung ist browserabhängig und wird im echten Browser geprüft |

## Grenzwerte (in `src/lib/image/limits.ts`)

- Dateigröße: max. 50 MB pro Datei
- Eingabe und Ausgabe: max. 40 Megapixel (≈ 160 MB RGBA pro Bitmap), max. 16 384 px Kantenlänge
- Stapel: max. 30 Dateien; weitere Dateien werden mit Hinweis abgelehnt, nicht still gekürzt
- Parallelität: 2 gleichzeitige Verarbeitungen, 1 bei `navigator.deviceMemory` ≤ 4 oder
  `hardwareConcurrency` ≤ 4 (Speicherschonung auf Mobilgeräten)

## Verbindliche Regeln für alle Arbeitspunkte

- Keine `style`-Attribute im gerenderten Markup (CSP blockiert sie); nur Tailwind-Klassen und Tokens.
  Fortschritt/Zustände über Klassen, `<progress>` oder Text.
- Worker nur als eigene Datei über `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`;
  keine `blob:`- oder Inline-Worker. Kein `fetch()` auf Objekt-URLs.
- Keine Netzwerkaufrufe, kein `console.*` mit Dateinamen oder -inhalten, keine Web-Storage-/
  IndexedDB-/Cache-Nutzung für Dateien.
- Nutzertexte auf Deutsch; Fehlermeldungen werden in der Oberfläche anhand von `ImageErrorCode` erzeugt.
- Keine Platzhalterbuttons, keine erfundenen Zahlen oder Versprechen.

## Arbeitspunkte

| ID | Titel | Verantwortung | Abhängig von | Status |
| --- | --- | --- | --- | --- |
| P01 | Projektgrundlage, Schnittstellenvertrag, Prüfwerkzeuge, Plan | Hauptagent | – | erledigt |
| P02 | Bildverarbeitungskern mit Worker und Browser-Tests | Subagent „Kern“ | P01 | offen |
| P03 | Seitengerüst, Gestaltungssystem, Startseite, Erklärseite, 404-Seite | Subagent „Oberfläche“ | P01 | erledigt |
| P04 | Gemeinsame Werkzeugoberfläche und Werkzeug „Bilder konvertieren“ | Subagent „Werkzeuge“ | P02, P03, P09 | offen |
| P05 | Werkzeug „Bilder komprimieren“ | Subagent „Werkzeuge“ | P04 | offen |
| P06 | Werkzeug „Bilder skalieren“ | Subagent „Werkzeuge“ | P04 | offen |
| P07 | Querschnitts-E2E: Netzwerk/Datenschutz, Ressourcen, Barrierefreiheit, Mobilansicht | Subagent „Prüfung“ | P04–P06 | offen |
| P08 | README und Projektdokumentation | Hauptagent | P07 | offen |
| P09 | Weitere Bildformate: ICO- und BMP-Export, GIF/BMP/ICO/AVIF-Eingabe | Subagent „Kern“ | P02 | offen |
| P10+ | Korrekturpunkte aus der abschließenden Prüfung (werden bei Bedarf ergänzt) | – | – | – |

P02 und P03 laufen parallel (getrennte Dateien, gemeinsamer Vertrag `types.ts`).
P09 wurde nachträglich auf Wunsch des Nutzers ergänzt (Icons und weitere Formate) und wird vor P04
umgesetzt, damit die Werkzeugoberfläche alle Formate von Beginn an kennt. Die IDs bleiben stabil;
die Reihenfolge der Commits ist daher P01, P02, P03, P09, P04 …
P05 und P06 laufen parallel; Einträge in `src/data/tools.ts` pflegt der Hauptagent.

### P01 – Projektgrundlage
Astro-, TypeScript-, Tailwind- und React-Konfiguration; Design-Tokens in `src/styles/global.css`;
CSP; Vitest-Browser- und Playwright-Konfiguration mit Smoke-Tests; Schnittstellenvertrag
`src/lib/image/types.ts`; dieser Plan und das Commit-Log.

### P02 – Verarbeitungskern (`src/lib/image/`, `tests/unit/`)
- `limits.ts`: Grenzwerte.
- `sniff.ts`: Formaterkennung über Signaturen, Abmessungen aus dem Header (PNG IHDR, JPEG SOFn,
  WebP VP8/VP8L/VP8X), EXIF-Orientierung, Erkennung animierter PNG (acTL) und WebP (ANIM/Flag).
  Abmessungsprüfung vor dem Dekodieren (Schutz vor Dekompressionsbomben).
- `probe.ts`: `probeImage` = Größenlimit + Signatur + Animation + Abmessungen.
- `resize.ts`: `computeTargetSize` (rein).
- `filename.ts`: `buildOutputFileName` (bereinigt, passende Endung).
- `encode.ts`: Zeichnen, JPEG-Hintergrundfüllung, Kodieren, MIME-Prüfung des Ergebnisses.
- `pipeline.ts`: probe → decode → Zielgröße → encode; gemeinsam für Worker und Hauptthread.
- `worker.ts` + `processor.ts`: `createImageProcessor` mit Worker-Pool, Warteschlange,
  Abbruch, Rückfall auf Hauptthread, `dispose`.
- Leere/fehlgeschlagene Canvas-Ergebnisse (z. B. Canvas-Flächengrenzen in Safari) als Fehler erkennen.
- Fehler über die Worker-Grenze als `{ code, message }` übertragen.
- Browser-Tests: Dekodierbarkeit, MIME/Endung/Signatur, Abmessungen, Transparenz→JPEG-Hintergrund,
  Qualitätswirkung, Orientierung, beschädigte/animierte/zu große Eingaben, Abbruch.

### P03 – Seitengerüst und statische Seiten
`BaseLayout`, Kopfzeile mit Navigation, Fußzeile, Startseite mit Werkzeugübersicht
(aus `src/data/tools.ts`), Seite „Lokale Verarbeitung“ mit sachlicher Erklärung (inkl. Hinweis,
dass Neukodierung Metadaten wie EXIF/GPS und Farbprofile entfernen kann), 404-Seite,
`<noscript>`-Hinweis. Wiederverwendbare Gestaltungsregeln (Buttons, Karten, Formularelemente).
Impressum/Datenschutzerklärung werden nicht erfunden; der Betreiber ergänzt sie vor der Veröffentlichung.

### P04 – Gemeinsame Werkzeugoberfläche + Konvertieren (`/bilder/konvertieren`)
Hook `useImageBatch` (Dateiliste, Prüfung, Stapelverarbeitung, Freigabe von Objekt-URLs),
Drop-Zone mit zugänglicher Dateiauswahl, Dateiliste mit Status, Ergebnisanzeige
(Original-/Ergebnisgröße, Änderung, „größer als Original“), Download, Optionsbausteine
(Format, Qualität, Hintergrundfarbe). Mehrfachauswahl, einzelne Datei entfernen, Auswahl
zurücksetzen, Grenzwerte sichtbar, Ablehnung überzähliger Dateien mit Hinweis, eindeutige
Ausgabenamen im Stapel, nicht unterstützte Ausgabeformate deaktiviert mit Begründung,
Metadaten-Hinweis, Hinweis bei Browsern ohne nötige APIs, `aria-live` für Status und Fehler,
Fokusführung nach dem Entfernen. Werkzeugseite Konvertieren mit E2E-Test.

### P05 – Komprimieren (`/bilder/komprimieren`)
Qualitätsregelung für JPEG/WebP, ehrliche Behandlung von PNG (keine wirkungslose Qualitätsregelung;
Hinweis auf Formatwechsel oder Verkleinerung), optionale maximale Kantenlänge. E2E-Test.

### P06 – Skalieren (`/bilder/skalieren`)
Prozent oder Breite/Höhe, Seitenverhältnis standardmäßig erhalten, Vergrößerung nur bewusst
aktivierbar, Ausgabeformat wählbar (Standard: wie Original; ist das Originalformat nicht
kodierbar, sichtbarer Hinweis statt stillem Ersatz). E2E-Test.

### P07 – Querschnittsprüfungen
E2E: keine Netzwerkanfragen mit Dateiinhalt/-namen während der Verarbeitung, keine Speicherung
in Web Storage/IndexedDB/Cache Storage, keine CSP-Verstöße, Freigabe von Objekt-URLs,
Tastaturbedienung, Mobilansicht, automatisierte Barrierefreiheitsprüfung (axe), falls sinnvoll.

### P09 – Weitere Bildformate
- Ausgabe ICO: eigener Encoder ohne Bibliothek (ICONDIR + PNG-kodierte Einträge), wählbare
  Größen (16, 32, 48, 64, 128, 256 px), quadratisch eingepasst mit transparentem Rand,
  Grenzwerte (Kante ≤ 256 px gemäß Format).
- Ausgabe BMP: eigener Encoder (24 bit ohne Alpha mit Hintergrundfarbe bzw. 32 bit mit Alpha – je
  nach Kompatibilität begründet entscheiden).
- Eingabe: statisches GIF, BMP, ICO (größter Eintrag), AVIF – nur sofern der Browser dekodiert;
  Signaturerkennung und Header-Abmessungen; animierte GIF/AVIF werden abgelehnt.
- Fähigkeitsprüfung für die Dekodierung (z. B. AVIF) statt Annahmen.
- Browser-Tests: Ausgabe dekodierbar, Struktur der ICO/BMP-Datei, Größen, Transparenz.

### P08 – Dokumentation
README (Voraussetzungen, Befehle, Architektur, Datenschutzverhalten, Formate, Grenzen).

## Spätere Erweiterungen (nicht Teil dieses Releases)
PDF-Werkzeuge, Audio- und Videokonvertierung, weitere Bildformate (z. B. AVIF- und GIF-Export),
ZIP-Download aller Ergebnisse. Für Office-Konvertierung (DOCX ↔ PDF) und PDF-Komprimierung in
Qualitätsstufen ist ein separater, optionaler Verarbeitungsdienst denkbar; dessen Planung erfolgt
außerhalb dieses Releases.
