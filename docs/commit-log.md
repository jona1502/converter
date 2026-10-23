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
