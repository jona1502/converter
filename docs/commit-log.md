# Commit-Log

Ein Eintrag pro Arbeitspunkt (siehe [implementation-plan.md](implementation-plan.md)).
Die Verbindung zur Git-Historie entsteht über die Arbeitspunkt-ID in der Commit-Nachricht.

## P01

- **Commit-Nachricht:** `feat(project): P01 Astro-Projektgrundlage einrichten`
- **Änderungen:** Astro 7 (statisch) mit React-Integration, Tailwind CSS 4 über `@tailwindcss/vite`,
  TypeScript strict, Design-Tokens, Content-Security-Policy mit `connect-src 'none'`,
  Vitest-Browser-Modus (Chromium, Firefox, WebKit) und Playwright-E2E gegen den Produktionsbuild
  (Chromium, Firefox, WebKit, mobiles Chromium),
  Schnittstellenvertrag des Bildkerns (`src/lib/image/types.ts`), vorläufige Startseite,
  Umsetzungsplan und dieses Log. Zweck: gemeinsame Grundlage, damit Kern und Oberfläche
  parallel entwickelt werden können.
- **Prüfung:** Review durch separaten Subagent. Übernommen: präzisierte Resize-Semantik,
  Fehlerübertragung über die Worker-Grenze, `onStart`/Abbruch/`dispose`-Vertrag, Hinweisfelder in
  `ProcessResult`, niedrigere Pixelgrenze und speicherabhängige Parallelität, WebKit in den Tests,
  verbindliche Regeln (keine style-Attribute, Worker als Datei), ergänzte Planpunkte.
- **Checks:** `npm run check` (0 Fehler, 0 Warnungen), `npm test` (1 Testdatei × 3 Browser,
  6 Tests bestanden), `npm run test:e2e` (4 Tests in Chromium, Firefox, WebKit, mobil bestanden;
  schließt `npm run build` ein), CSP-Meta-Tag im Build geprüft.
- **Einschränkungen:** Startseite ist ein Platzhalter bis P03. Playwright-Browser müssen einmalig
  mit `npx playwright install chromium firefox webkit` installiert werden. WebKit unter Windows
  entspricht nicht exakt Safari auf macOS/iOS.

## P03

- **Commit-Nachricht:** `feat(site): P03 Seitengerüst und Startseite hinzufügen`
- **Änderungen:** `BaseLayout` (Skip-Link, Landmarks, `noscript`-Hinweis, optionales `noindex`),
  Kopf- und Fußzeile, typisierte Werkzeugliste `src/data/tools.ts` (Bildwerkzeuge noch
  `available: false`, damit keine toten Links entstehen), Startseite, Erklärseite
  „Lokale Verarbeitung“ (lokale Verarbeitung, keine Speicherung, CSP, Metadaten, Orientierung,
  Browsergrenzen; ohne rechtliche Zusicherungen oder Betreiberangaben), 404-Seite, Favicon,
  Gestaltungssystem in `global.css` (Buttons, Karten, Formulare, Hinweise, Badges; dokumentiert,
  Kontraste nach WCAG nachgerechnet, neuer Token `border-control`). E2E-Tests für Rendering,
  CSP-Verletzungen, fremde Hosts, Tastatur, Skip-Link, 320 px Breite, interne Links.
  Zusätzlich: E2E-Port auf 4329 verlegt (kollidierte mit einem laufenden Dev-Server auf 4321),
  Markdown-Syntaxhervorhebung abgeschaltet (Shiki-Inline-Styles wären per CSP blockiert),
  Plan um P09 (weitere Bildformate, Wunsch des Nutzers) ergänzt.
- **Prüfung:** Review durch separaten Subagent. Behoben: deaktivierte Buttons wechselten beim
  Hovern auf unlesbaren Kontrast (Hover jetzt nur für aktive Buttons), Orientierungsaussage auf
  „aktuelle Browser“ präzisiert, `noscript` in `<main>`, `noindex` für 404, Ablauf-Abschnitt nur
  bei verfügbaren Werkzeugen, `min-h-dvh`, Doku zu `aria-disabled` auf Links, Formulierung in
  `tools.ts`, 404-Seite in CSP-/Fremd-Host-Prüfung inkl. Erkennung fehlender Unterressourcen.
- **Checks:** `npm run check` (0 Fehler, 0 Warnungen; 2 Hinweise in noch nicht committeten
  P02-Dateien), `npm run test:e2e` (48 Tests in Chromium, Firefox, WebKit, mobil bestanden;
  schließt Produktionsbuild ein).
- **Einschränkungen:** Nur helles Farbschema. In WebKit (Windows) nimmt die Tab-Reihenfolge
  keine Links auf; der Test fokussiert dort per Skript und prüft die Aktivierung per Enter.
  Impressum/Datenschutzerklärung fehlen bewusst und sind vor einer Veröffentlichung vom Betreiber
  zu ergänzen. Die Aussage „Dateien werden beim Entfernen verworfen“ wird erst mit P04/P07
  implementiert bzw. getestet.
