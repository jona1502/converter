# Commit-Log

Ein Eintrag pro Arbeitspunkt (siehe [implementation-plan.md](implementation-plan.md)).
Die Verbindung zur Git-Historie entsteht über die Arbeitspunkt-ID in der Commit-Nachricht.

## P09

- **Commit-Nachricht:** `feat(images): P09 ICO und BMP sowie weitere Eingabeformate ergänzen`
- **Änderungen:** Eigene 24-bit-BMP- und PNG-basierte ICO-Encoder; wählbare ICO-Größen mit transparentem Rand. Headerprüfung für statische GIF/BMP/ICO/AVIF, größter ICO-Eintrag, echte Decoder-Fähigkeitsprüfung in Worker und Hauptthread. BMP-Ausgabe auf 100 MiB begrenzt. Schnittstellen und Browser-Tests erweitert.
- **Prüfung:** Separater Agent hat Integrationslücken gefunden und behoben; Hauptagent hat Pipeline, Encoder, Decoder-Prüfung und Worker-Vertrag unabhängig geprüft. Übergabestand war noch nicht integriert.
- **Checks:** Hauptagent: `npm run check` (0 Fehler/Warnungen/Hinweise), `npm run build` erfolgreich; gezielte Browser-Tests für erweiterte Formate, Pipeline, Prozessor, Limits und Typen: 168 bestanden, 3 bestehende übersprungen. Agent: vollständiger oberster Unit-Testsatz einschließlich Größenformatierung: 303 bestanden, 3 übersprungen, Chromium/Firefox/WebKit.
- **Einschränkungen:** Eingabedekodierung browserabhängig; Animation wird abgelehnt. AVIF-Abmessungen werden konservativ aus den Headerangaben bestimmt. BMP ist unkomprimiert und ohne Alpha; ICO enthält PNG-Einträge für aktuelle Programme. Die übersprungenen Tests betreffen den fehlenden WebP-Encoder, den alle Testbrowser besitzen.

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

## P02

- **Commit-Nachricht:** `feat(images): P02 Bildverarbeitungskern hinzufügen`
- **Änderungen:** Kern unter `src/lib/image/`: Formaterkennung über Signaturen, Header-Abmessungen
  (PNG, JPEG-SOFn, WebP VP8/VP8L/VP8X), EXIF-Orientierung, Erkennung animierter PNG/WebP
  (`sniff.ts`, `probe.ts`), Grenzwerte und speicherabhängige Parallelität (`limits.ts`), Zielgröße
  (`resize.ts`), bereinigte und eindeutige Dateinamen (`filename.ts`), Zeichnen/Kodieren mit
  schrittweiser Verkleinerung, JPEG-Hintergrund, Prüfung von MIME-Typ und Signatur des Ergebnisses
  (`encode.ts`, `canvas.ts`), Pipeline mit Grenzprüfung vor und nach dem Dekodieren
  (`pipeline.ts`), Worker mit Protokoll und Prozessor mit Warteschlange, Abbruch, `dispose` und
  Rückfall auf den Hauptthread (`worker.ts`, `worker-protocol.ts`, `processor.ts`, `errors.ts`).
  Browser-Tests in `tests/unit/`. Zusätzlich im Plan: Arbeitspunkte P10/P11 (PDF-Komprimierung,
  Wunsch des Nutzers, Technikentscheidung `@cantoo/pdf-lib`) und Regel für Größenangaben.
- **Prüfung:** Review durch separaten Subagent (kein kritischer/hoher Befund; zusätzlich
  Sniffer-Fuzzing mit 200.000 Zufallseingaben ohne Ausnahme). Behoben: `transparencyFlattened`
  prüft echte Alphawerte statt Header-Vermutung, zeitabhängige Prozessor-Tests deterministisch,
  Tests mit vom Browser kodiertem WebP, JPEG-Eingaben, Orientierungen 3/6/8 und Nachweis, dass bei
  Grenzverletzung nicht dekodiert wird; Worker-Leck bei `postMessage`-Fehler, `getEncodeSupport`
  nach `dispose`, Erkennung ungedrehter Bitmaps, Grenzprüfung der dekodierten Bitmap, Freigabe
  temporärer Canvas, Bidi-Zeichen und reservierte Windows-Namen in Dateinamen, weniger Casts.
- **Checks:** `npm run check` (0 Fehler, 0 Warnungen, 0 Hinweise); Vitest für die Bildkern-Tests
  in Chromium, Firefox und WebKit: 24 Testdateien (8 × 3 Browser), 255 bestanden, 3 übersprungen
  (Test „Browser ohne WebP-Encoder“ – alle drei Testbrowser kodieren WebP); `npm run build`
  erfolgreich (laut Subagent).
- **Einschränkungen:** WebKit bietet kein OffscreenCanvas; dort läuft die Verarbeitung im
  Hauptthread. Der echte Fall „Browser kodiert WebP nicht“ (Safari) ist nur über einen
  nachgestellten Encoder getestet. EXIF-Orientierung wird nur in JPEG-Headern ausgewertet
  (maßgeblich bleibt die dekodierte Bitmap). Zerstörte Bilddaten bei intaktem Header dekodieren
  manche Browser ohne Fehler zu teilweise leeren Bildern; das ist nicht zuverlässig erkennbar.
  Abbruch im Hauptthread verwirft nur das Ergebnis, die laufende Canvas-Arbeit läuft zu Ende.
  Der Worker im Produktionsbuild wird erst mit P04 (erste Seite, die den Kern lädt) prüfbar.
