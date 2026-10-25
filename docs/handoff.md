# Übergabe (Stand 2026-10-23, Branch `release/v1`)

Diese Datei beschreibt den Arbeitsstand bei der Übergabe an einen anderen Agenten.
Verbindliche Regeln und Plan: [implementation-plan.md](implementation-plan.md),
Commit-Dokumentation: [commit-log.md](commit-log.md). Auftrag des Nutzers zusammengefasst:
deutschsprachige, statische Astro-Website, Dateiverarbeitung vollständig lokal im Browser,
pro Arbeitspunkt genau ein Commit inkl. Eintrag in `commit-log.md` (ohne eigenen Hash),
vor jedem Commit Review durch einen anderen Agenten, gezieltes Stagen (kein `git add .`),
keine Pushes, keine destruktiven Git-Befehle.

## Committet (geprüft)

| Commit | ID | Inhalt |
| --- | --- | --- |
| `63018b3` | P01 | Projektgrundlage, CSP, Testinfrastruktur, Vertrag `src/lib/image/types.ts`, Plan |
| `44b4778` | P03 | Layout, Startseite, Erklärseite, 404, Gestaltungssystem (`global.css`) |
| `4f2121c` | P02 | Bildkern JPEG/PNG/WebP (`src/lib/image/`), Browser-Tests (`tests/unit/`) |

## Nicht committet – in Arbeit gewesen, NICHT geprüft

Diese Änderungen stammen von Subagents, die zum Übergabezeitpunkt noch liefen. Sie können
unvollständig sein. Vor einem Commit: fertigstellen, `npm run check` / `npm test` /
`npm run build` / `npm run test:e2e` ausführen, unabhängig reviewen lassen.

| ID | Dateien | Inhalt |
| --- | --- | --- |
| P09 | `src/lib/image/types.ts` (geändert), `src/lib/image/bytes.ts`, `src/lib/image/sniff-formats.ts`, weitere in `src/lib/image/`, `tests/unit/*` | ICO-Export (eigener Encoder, PNG-Einträge, Größen 16–256), BMP-Export (24 bit), Eingabe GIF/BMP/ICO/AVIF (nur statisch, Dekodierfähigkeit prüfen). Details: Abschnitt P09 im Plan. |
| P10 | `src/lib/pdf/`, `src/lib/format.ts`, `tests/unit/pdf/`, `tests/unit/format.test.ts`, `package.json`/`package-lock.json` (`@cantoo/pdf-lib`) | PDF-Komprimierung mit drei Stufen (Hohe Qualität / Ausgewogen / Kleine Datei) per Bild-Neukodierung, Worker, Varianten nacheinander. `format.ts`: Größenangaben dezimal, KB unter 1.000.000 Bytes, sonst MB, `de-DE`. Details: Abschnitt P10 im Plan. |
| P04 | `src/components/tools/`, `src/pages/bilder/konvertieren.astro`, `e2e/convert.spec.ts`, ggf. `global.css` | Gemeinsame Werkzeug-UI (`useImageBatch`, DropZone, Dateiliste, Optionen, Download) und Seite „Bilder konvertieren“. Muss nach P09 an neue Formate (ICO-Größen, BMP) angepasst werden. |

Commit-Reihenfolge wegen Abhängigkeiten: P09 → P10 → P04 (P04 nutzt neue Formate und `format.ts`).
`src/data/tools.ts`: Werkzeuge stehen auf `available: false`; erst freischalten, wenn die Seite
existiert (sonst schlägt der Tote-Link-Test fehl).

## Offen

| ID | Inhalt |
| --- | --- |
| P05 | Seite `/bilder/komprimieren` (Qualität nur JPEG/WebP, PNG ehrlich behandeln, optionale max. Kante) |
| P06 | Seite `/bilder/skalieren` (Prozent/Breite/Höhe, Seitenverhältnis an, Vergrößerung bewusst) |
| P11 | Seite `/pdf/komprimieren` (drei Varianten nacheinander, echter Status, echte Größen, „größer/keine Einsparung“ kennzeichnen, Ressourcen bei Reset freigeben) |
| P07 | Querschnitts-E2E: Netzwerk, keine Speicherung, Objekt-URLs, CSP, Tastatur, Mobil, axe |
| P08 | README (Installation, Befehle, Architektur, Datenschutz, Formate, Grenzen) |
| P12+ | Abschließende unabhängige Prüfung (Funktion, Datenschutz, Barrierefreiheit, Architektur/Tests) und Korrekturpunkte mit je einem Commit |

## Technische Hinweise

- Befehle: `npm run dev -- --port 3000` (4321 vermeiden), `npm run check`, `npm test`
  (Vitest-Browser-Modus: Chromium, Firefox, WebKit), `npm run build`, `npm run test:e2e`
  (Playwright gegen Build auf Port 4329). Browser einmalig: `npx playwright install chromium firefox webkit`.
- CSP (`astro.config.mjs`): keine `style`-Attribute, auch kein React `style={{}}`;
  Worker nur als Datei über `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`.
- WebKit hat kein OffscreenCanvas → Bildkern fällt dort auf den Hauptthread zurück.
- Backend (DOCX ↔ PDF usw.) ist nicht Teil dieses Releases und wird separat geplant.
