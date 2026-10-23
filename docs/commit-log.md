# Commit-Log

## P13

- **Commit-Nachricht:** `refactor(site): P13 FAQ von der Konvertierungsseite entfernen`
- **Änderungen:** Auf Nutzerwunsch gesamten FAQ-Abschnitt einschließlich aller fünf Fragen und Antworten entfernt. Keine weiteren FAQ-Abschnitte in den Werkzeugseiten gefunden.
- **Prüfung:** Unabhängiger Agent hat den gezielten Seitendiff ohne Befunde freigegeben; Hauptagent prüfte Umfang und Suchtreffer.
- **Checks:** `npm run build` unter Node 24 erfolgreich, sieben statische Seiten erzeugt. Kein neuer Test für die reine Textentfernung.
- **Einschränkungen:** Keine neuen; bestehende Verarbeitungshinweise bleiben im Werkzeug und auf der Infoseite.

## P12

- **Commit-Nachricht:** `docs(release): P12 unabhängige Abschlussprüfung dokumentieren`
- **Änderungen:** Abschlussbericht mit Reviews, tatsächlichen Ergebnissen, Browserbesonderheiten und verbleibenden Grenzen; Plan abgeschlossen. Kein zusätzlicher Produktumfang.
- **Prüfung:** Drei Subagents prüften fremde Bereiche des integrierten Stands unabhängig; keine weiteren bestätigten Produktfehler. Hauptagent prüfte Integration und Screenshots des Produktionsbuilds.
- **Checks:** Vollständiges `npm run verify` unter Node 24.21.0 mit Exit 0: Astro-Check 89 Dateien ohne Befunde, Unit-Tests 42 Dateien/410 bestanden/10 fähigkeitsabhängig übersprungen, statischer Build mit 7 Seiten, E2E 136/136 bestanden (Chromium/Firefox/WebKit/mobil, einschließlich 16 axe-Prüfungen). Frühere Firefox-Close-Probleme im Abschlusslauf nicht reproduziert.
- **Einschränkungen:** Siehe `release-review.md` und README; insbesondere PDF-Browserfähigkeiten, komplexe PDF-Inhalte, best-effort Speichergrenzen und ausstehende echte Safari/iOS-Prüfung. Kein Deployment/Push; `docs/handoff.md` bleibt bewusst uncommittet.

## P08

- **Commit-Nachricht:** `docs(project): P08 Bedienung Architektur und Grenzen dokumentieren`
- **Änderungen:** README mit Installation, Start/Prüfbefehlen, Architektur, Formaten, Datenschutz und konkreten Grenzen. Infoseite um PDF-Verarbeitung, Signaturen, Browsergrenzen und präzise Speicherfreigabe ergänzt; Bild-Metadatenaussagen abgegrenzt. Größen-/Einheitenpräzisierungen im Plan und fehlenden Abstand vor FAQ-Link korrigiert.
- **Prüfung:** Zwei unabhängige Agenten prüften Konsistenz mit Code und Verhalten. Hinweise zu 50 MiB, Anzeige nach jeder Variante und exakter MB-Schwelle übernommen. Hauptagent sichtete gerenderte Konverter-/PDF-Seiten zusätzlich visuell.
- **Checks:** Typprüfung 89 Dateien ohne Befunde; letzter Produktionsbuild erfolgreich. Änderungen sind überwiegend Dokumentation; vollständige Prüfung läuft im Abschlussarbeitspunkt P12.
- **Einschränkungen:** Hosting/Rechtstexte und echte Safari/iOS-Prüfung bleiben Betreiberaufgaben. Keine Deployment-Konfiguration erstellt. Die ursprüngliche Übergabedatei bleibt wie angefordert uncommittet.

## P07

- **Commit-Nachricht:** `test(release): P07 Datenschutz und Barrierefreiheit prüfen`
- **Änderungen:** Querschnittstests für alle vier Werkzeuge: Context-Netzwerkereignisse, WebSockets, Dateinamen, Window-Speichernutzung, CSP, URL-Widerruf, Tab/Enter-Dateiauswahl, lange Namen und mobile Ergebnisse. Statischer Audit der Worker-Kernquellen, axe-WCAG-Prüfung nach Verarbeitung. E2E auf zwei Worker begrenzt, axe-Abhängigkeit ergänzt.
- **Prüfung:** Unabhängiger Agent fand und schloss Lücken im ursprünglichen Audit (Origin, Worker-Anfragen, PDF/weitere Tools, befüllte Zustände). Hauptagent prüfte finale Tests und eng begrenzte Browser-Ausnahmen.
- **Checks:** 52 Tests registriert. Vollrunde: 51/52 bestanden einschließlich aller 16 axe-Prüfungen. Ein WebKit-spezifischer Allowlistfehler behoben; betroffener Test anschließend unter Node 24.21.0 1/1 bestanden. Typprüfung danach 89 Dateien ohne Befunde. Vollständige Release-Prüfung folgt P12.
- **Einschränkungen:** Window-Instrumentierung erfasst keine Worker-Speicher-APIs; statischer Quellaudit ergänzt sie, ist aber kein formaler Sicherheitsbeweis. Native WebKit-Selects erzeugen selbst in skriptfreiem Minimal-HTML einen exakt eingegrenzten CSP-Stilattribut-Event, den der Test ausnimmt; tatsächliche Inline-Styles bleiben verboten. WebKit kennzeichnet lokale Blob-Dekodierung und eigene Modul-Worker als XHR; nur diese lokalen GET-Fälle sind zusätzlich zugelassen. Anwendungs-CSP unverändert streng.

## P11

- **Commit-Nachricht:** `feat(tools): P11 PDF-Komprimierung mit drei echten Ergebnisgrößen ergänzen`
- **Änderungen:** PDF-Seite mit Dateiauswahl/Drop, Analyse, seriell automatisch berechneten Qualitätsstufen, echten KB/MB und Prozentvergleich, Downloads, Browsergrenzen und Reset. Signaturwarnung vor Auswahl, transparente Grenzen, Generationstoken und Worker-/URL-Freigabe. Kategorie und Werkzeug freigeschaltet.
- **Prüfung:** Hauptagent und unabhängiger UI-Agent reviewten. Behoben: Button-Basisklassen, sichere Dateinamen, Drop außerhalb der Zone, präzise Auflösungsbeschreibung, global abgebrochene Varianten korrekt auf Fehler und Variantenkarten erst nach erfolgreicher Analyse.
- **Checks:** Produktionsbuild erfolgreich, PDF-E2E nach letzten Änderungen 8/8 in Chromium/Firefox/WebKit/mobil bestanden (Node 24). Prüft drei Downloads bzw. explizite Browsergrenze, Downloadname, Analyse, Reset/Fokus und beschädigte Eingabe.
- **Einschränkungen:** Keine Vorschätzung: Größen erst nach echter Berechnung. WebKit ohne OffscreenCanvas zeigt Browsergrenze. PDF-Kerngrenzen aus P10 gelten. Signaturen und PDF/A können durch Neuschreiben ungültig werden.

## P06

- **Commit-Nachricht:** `feat(tools): P06 Bildskalierung mit Originalformat ergänzen`
- **Änderungen:** Prozent- und Pixelgrößen, Seitenverhältnis standardmäßig erhalten, Vergrößerung bewusst aktivieren, Originalformat pro Datei oder wählbares Zielformat. Gemeinsamer Hook löst Einstellungen einmal je Datei auf; Namen und Kodierung verwenden denselben Snapshot. Werkzeug freigeschaltet.
- **Prüfung:** Unabhängiges Review durch Hauptagent und zwei weitere Agenten, keine Blocker. Finalen Hinweis für nicht unterstützte Browser präzisiert. Nicht kodierbare Originalformate werden sichtbar blockiert statt ersetzt.
- **Checks:** Agent unter Node 24: Typprüfung ohne Befunde, Produktionsbuild erfolgreich und P05/P06-E2E 12/12 in Chromium/Firefox/WebKit/mobil bestanden. Abgedeckt: gemischter PNG/JPEG-Stapel, Prozentwerte, Upscale-Sperre/Freigabe, Verhältnis und exakte Zielmaße.
- **Einschränkungen:** GIF/AVIF/ICO können im Skalierwerkzeug nicht als Originalformat ausgegeben werden; ein anderes Zielformat ist nötig. Neukodierung und Kernlimits gelten auch bei Originalformat.

## P05

- **Commit-Nachricht:** `feat(tools): P05 Bildkomprimierung ergänzen`
- **Änderungen:** Komprimierungsseite mit JPEG/WebP-Qualität, ehrlichem PNG-Hinweis, Hintergrundfarbe und optionaler maximaler Kantenlänge. Vorhandene Stapelverwaltung, Größenvergleich und Download werden wiederverwendet. Werkzeug freigeschaltet.
- **Prüfung:** Hauptagent prüfte Implementierung unabhängig auf Eingabegrenzen, PNG-Verhalten, Ressourcen und Einstellungswechsel.
- **Checks:** Agent unter Node 24: `npm run check` (88 Dateien, keine Befunde), Produktionsbuild erfolgreich; P05/P06-E2E gemeinsam 12/12 in Chromium/Firefox/WebKit/mobil bestanden. P05 prüft PNG-Verkleinerung, JPEG-Wechsel, ungültige Kante und Reset.
- **Einschränkungen:** Keine garantierte Einsparung; PNG wird verlustfrei neu kodiert. Browserfähigkeiten und Bildkernlimits gelten weiterhin.

## P04

- **Commit-Nachricht:** `feat(tools): P04 Bildkonverter und gemeinsame Werkzeugoberfläche ergänzen`
- **Änderungen:** React-Stapelverwaltung, Dropzone, Format-/Qualitäts-/Hintergrund-/ICO-Einstellungen, Dateiliste mit echten Größen, Downloads, Abbruch und URL-Freigabe; Konvertierungsseite und Navigation freigeschaltet. Prüfung der Eingabedekodierfähigkeit vor Verarbeitung, eindeutige Ausgabenamen, Fokusführung und zugängliche Statusansagen.
- **Prüfung:** Unabhängiges Review durch separaten Agent und Hauptagent. Behoben: verspätete Statusansagen nach Reset mittels Generationstoken, Fokusrennen beim Entfernen während Vorabprüfung und mehrdeutige Dateifeld-/Buttonbeschriftung.
- **Checks:** Typprüfung vor den unabhängigen P06-Vorbereitungen fehlerfrei; Produktionsbuild erfolgreich. Agent: Konverter-E2E Chromium/WebKit/mobil 12/12 bestanden; Firefox-Funktionsassertions ausgeführt, allerdings Playwright-Protokollfehler beim Schließen des Browserkontexts. Zusätzliche P07-Konvertertests in Chromium/mobil bestanden. Keine Behauptung eines vollständig grünen Firefox-E2E-Laufs.
- **Einschränkungen:** Playwright-Firefox unter dieser Windows-Umgebung meldet sporadisch `_maybeDontRestoreTabs` bei Context.close. WebKit erzeugt für native Selects bereits ohne Appcode einen style-src-attr-CSP-Verstoß; separater Minimalfall bestätigt. P07 grenzt diesen Testbrowser-Effekt eng ein, die Anwendungs-CSP wird nicht gelockert. P05/P06/P11 sind eigene Arbeitspunkte.

## P10

- **Commit-Nachricht:** `feat(pdf): P10 lokalen PDF-Komprimierungskern ergänzen`
- **Änderungen:** PDF-Analyse und drei seriell berechnete Varianten mit tatsächlichen Bytegrößen; JPEG-/Flate-RGB-/Gray-Neukodierung, DPI-/Kantenlimits, Objekt- und Streamoptimierung. PDF-Worker mit Abbruch und Ergebnisbudget. Gemeinsame dezimale KB/MB-/Prozentformatierung, `@cantoo/pdf-lib` und Node-Typen für Browser-Teststeuerung ergänzt.
- **Prüfung:** Agent vervollständigte Kern und Regressionstests, Hauptagent prüfte unabhängig Verarbeitung, Streams, Platzierungsanalyse, Ressourcen und Worker-Vertrag. Befunde behoben: Transportfehler-Cleanup, inkrementelle Content-Auswertung, spezielle Profile/Masken konservativ unverändert, Parserwarnungen im dedizierten Worker unterdrückt.
- **Checks:** Typprüfung vor den unabhängigen P06-Vorbereitungen und statischer Build erfolgreich. Abschließender Agent-Lauf `npm test -- tests/unit/pdf tests/unit/format.test.ts`: 15 Browser-Testdateien bestanden, 125 Tests bestanden, 7 übersprungen, Exit 0. Hauptagent hatte zuvor Firefox-Zeitüberschreitungen im parallelen Lauf bestätigt. Dateiparallelität deshalb abgeschaltet; nur rechenintensive Verschlüsselungs-Fixturetests erhalten 60 Sekunden. Node 24 für weitere Prüfungen verwendet.
- **Einschränkungen:** WebKit ohne OffscreenCanvas unterstützt Analyse, aber keine Worker-Komprimierung (entsprechende Tests übersprungen). Kein hartes Parser-Speicherlimit; eingebettete Schriften, besondere Farbräume und maskierte Bilder bleiben unverändert. Signaturen werden ungültig, PDF/A wird nicht garantiert. Größen können steigen. P11 liefert erst die Benutzeroberfläche.

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
