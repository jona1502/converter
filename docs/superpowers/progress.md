# Dateiwerkstatt – Fortschritt und Nachweise

**Stand:** 03.11.2026. **Branch:** `redesign/file-workshop`. **Unveränderte Ausgangsbasis:** `0d356572a3f506af08c8b0cf0d8187bb638bba76` auf `main`. [Plan](plans/2026-11-03-redesign-audit-plan.md) · [Spezifikation](specs/2026-11-03-file-workshop-design.md) · [Laufzeitdiagnose](runtime-diagnosis.md).

## Verbindliche Entscheidungen

| ID | Anlass | Entscheidung |
| --- | --- | --- |
| R1 | Umsetzungsfreigabe nach vorläufigem Plan | Die empfohlene Dateiwerkstatt gilt als gewählt. Keine erneute Freigabeschleife für bereits beauftragte Schritte. |
| R2 | Spätere ausdrückliche Nutzeranweisung | Jeder Planpunkt erhält mehrere fachlich sinnvolle Teilcommits; die frühere Ein-Commit-Regel ist ersetzt. Keine leeren oder künstlichen Commits. Deutsche Commitbodys nennen Inhalt, Zweck und tatsächliche Prüfungen. |
| R3 | Isolation und vorhandene Umgebung | Bestehender Checkout mit dedizierter Branch statt zusätzlichem Worktree; installierte Windows-/Testumgebung und IDE-Kontext bleiben erhalten. Git-Verzeichnis und Common-Dir waren beide `.git`, kein Submodul und kein vorhandener Linked Worktree. Kein Merge/Push, keine Produktänderung auf `main`. |
| R4 | Parallel arbeitende Subagents | Dateizuständigkeiten abgrenzen, gemeinsame Dateien zeitlich serialisieren, Git-Commits ausschließlich nacheinander und mit expliziten Pfaden stagen. Root koordiniert unabhängige Reviews. |
| R5 | Historische und aktuelle Nachweise | Die Auditbaseline im Plan bleibt ein datierter Befund. Neue Diagnoseergebnisse werden separat ergänzt; ein früherer Timeout oder gestoppter Daemon ist kein belegter Produktfehler. |
| R6 | TDD und Planreihenfolge | Bei neuen Verhaltensänderungen oder Fehlerkorrekturen zuerst einen aussagekräftigen fehlschlagenden Regressionstest nachweisen. Später im Plan aufgeführte Tests erlauben keine testlose Verhaltensänderung. Reine Gestaltung/Dokumentation braucht keine implementationstreuen Zusatztests. |
| R7 | Review-/Fullstackgrenzen | Unabhängige Reviews und echte Linux-/Dateidurchläufe gesondert nachweisen. Browser-Mocks oder Token-Kontrastberechnungen ersetzen keine Fullstack- oder gerenderte visuelle Abnahme. |

## Gesicherter Ausgangsstand

- Vor Beginn: `git status --short` zeigte ausschließlich den noch nicht versionierten Plan unter `docs/superpowers/`; keine veränderten Produktdateien. Es wurden keine `AGENTS.md` im Repository oder dessen Vorfahren gefunden.
- Der Werkzeugkatalog, `BaseLayout.astro`, die vier Werkzeugkomponenten, `useImageBatch.ts`, Formathilfen und Playwright-Konfiguration wurden für die Spezifikation gelesen. Das funktionale Prüfinventar steht in der Spezifikation; vollständige Ausführung folgt bei den zuständigen Punkten.
- Laufzeitdiagnose: vorhandener Vitest-Runner mit 60-Sekunden-Grenze, Exit 0 nach 51,16 Sekunden: **42 Testdateien, 410 bestanden, 10 bestehende Browser-Skips**. Historischer Hänger nicht reproduziert; kein Produkt-/Konfigurationspatch. Chromium, Firefox und WebKit ließen sich unabhängig starten. Details und exakter Befehl im Diagnosebericht.
- Docker: Der zuvor gestoppte Linux-Daemon ist nach Start von Docker Desktop erreichbar; `docker version` und Compose-Konfigurationsprüfung Exit 0. Bestehende Container liefen durch ihre Restart-Policies wieder an und wurden nicht verändert. Das hebt die Runtimeblockade auf, ist aber noch kein Linux-Backendtest.
- Weitere Werte aus der ursprünglichen Auditbaseline wurden in diesem Dokumentationsschritt nicht erneut ausgeführt. Browser-E2E, Linux-Race-/Codec-/DB-/Valkeyprüfungen und echte Dateiaufgaben sind weiterhin offene Ausführungsnachweise.

## Preflight: jede Aufgabe gegen ihren eigenen Vertrag

Die Tabellen wurden vor Produktänderungen gegen alle zehn Planpunkte und die konkretisierte Spezifikation geprüft. Rulings beziehen sich auf die verbindlichen Entscheidungen oben; offene Infrastruktur ist kein Grund für einen erfundenen Produktpatch.

| Punkt | Eigenprüfung: Dateien, Tests, Ergebnis | Befund und Ruling |
| --- | --- | --- |
| 1 | Plan, neue Spec, Ledger und Auditbaseline; historisches Handoff bleibt unangetastet. | Frühere Freigabe-/Ein-Commit-Texte widersprachen aktueller Nutzeranweisung: ersetzt, R1/R2. Diagnose separat belegt, R5. |
| 2 | Dokumentierte Composebefehle, echte Dateien und gezielte Regression nur bei Fehler. | Kein innerer Widerspruch; Docker inzwischen erreichbar. Windows-Pfade nicht als Linuxproduktfehler behandeln, R5/R7. |
| 3 | Tokens/Controls in global.css, BaseLayout-Metadaten, check/build/axe/Kontrast. | Kein innerer Widerspruch. Favicon optional, keine erzwungene Markenänderung; CSP bindend. |
| 4 | Header/Footer/Home/Katalog, Navigationstests und responsive/No-JS-Fälle. | Bestehender Katalog bleibt Quelle; neue kompakte Navigation ersetzt alte Bedienfälle sachgerecht, R6. |
| 5 | Drei Bildwerkzeuge, optional reine Layoutkomponente, optionsKey und Werkzeugtests. | Hook-/API-Vertrag bleibt; keine neue Statuslogik in Layoutkomponente. DOM-Reihenfolge verbindlich. |
| 6 | Gemeinsame Auswahl/Aktionen/Dateiliste/Hinweise plus Lebenszyklusfälle. | Statusgestaltung darf keinen Resetfehler verdecken; falls reproduziert, Regression vor gezielter Korrektur, R6. |
| 7 | PDF-Komponente/Seite, echte drei Varianten und Lifecycle-/A11ytests. | Keine neue Stufe; Teilfehler separat. Layout kann gemeinsame Komponente konsumieren, R4. |
| 8 | Tool-/Infotexte/404 und bestehende Alt-URL, Privacy-/Sitetests. | Verarbeitung ist serverseitig; Betreiberangaben werden nicht erfunden. Überschneidende PDF-/Hinweisdateien serialisieren, R4. |
| 9 | Gesamtdiff, separater Infrastrukturreview und notwendige gezielte Korrekturen. | Unabhängigkeit der Reviewer gegenüber Implementierern dokumentieren; keine pauschale Backendneuerfindung, R7. |
| 10 | Tatsächliche Prüfmatrix und Übergabe ohne beiläufige Produktänderung. | Vollständiger Abschluss setzt Linux-/Fullstackbeweis voraus. Nicht ausgeführte Fälle bleiben offen, R7. |

## Preflight: gemeinsame Dateien und Schnittstellen aller Aufgabenpaare

| Paar | Produzent → Verbraucher / geteilte Fläche | Ergebnis und Entscheidung |
| --- | --- | --- |
| 1–2 | Freigegebener Umfang/Baseline → Backendnachweise | Historische Befunde bleiben datiert; aktuelle Befunde ergänzen, R5. |
| 1–3 | Spec → Tokens/Seitengerüst | Farb-/Layoutvertrag konsistent; gerenderte Kontraste gesondert prüfen. |
| 1–4 | Spec → Navigation/Home | Direkte Auswahl ohne Hero verbindlich. |
| 1–5 | Spec → drei Bildarbeitsbereiche | Alle Optionen und DOM-Reihenfolge erhalten. |
| 1–6 | Spec → gemeinsame Status-/Ergebnisbausteine | Zustände aus tatsächlichem Hook/API-Vertrag. |
| 1–7 | Spec → PDF-Arbeitsbereich | Genau drei bestehende Varianten. |
| 1–8 | Spec/Betriebsvertrag → Texte | Keine browserlokale Zusicherung. |
| 1–9 | Spec/Plan → Reviewmaßstab | Spec ist fachliche Autorität; aktuelle Rulings berücksichtigen. |
| 1–10 | Ledger/Baseline → Abschlussmatrix | Commit-/Prüfnachweise fortschreiben; keine ungeprüften Häkchen. |
| 2–3 | Serverzustände → gestalterische Statussemantik | Kein direkter Dateikonflikt; keine erfundenen Fortschrittswerte. |
| 2–4 | Capabilities/Serverhinweis → direkte Werkzeugauswahl | Katalog erhalten; keine neue Backendverfügbarkeit suggerieren. |
| 2–5 | API/Optionen → Bildwerkzeuge | Bestehenden Vertrag konsumieren, kein API-Umbau. |
| 2–6 | Jobzustand/Ablauf/Reset → gemeinsame Ergebnisse | Echte Fehler reproduzieren; Regression vor Korrektur, R6. |
| 2–7 | PDF-Analyse/Varianten → PDF-Oberfläche | Echte Durchläufe von Mocks getrennt, R7. |
| 2–8 | Speicher-/Löschvertrag → Verarbeitungstexte | Texte müssen tatsächlichen Betrieb beschreiben. |
| 2–9 | Infrastrukturbelege/release-review → unabhängiger Review | Geteilte Dokumente serialisieren; Unabhängigkeit erhalten, R4/R7. |
| 2–10 | Linux-/Dateibelege/release-review → finaler Nachweis | Nur erforderliche Wiederholung bei Änderungen/offenen Bedenken. |
| 3–4 | Tokens/BaseLayout → Header/Footer/Home | Globale Klassen stabil halten; Dateien abgrenzen, R4. |
| 3–5 | Controls/Panelklassen → Bildlayouts | Layoutbaustein rein darstellend; konsistente Tokens. |
| 3–6 | Zustandsklassen → Auswahl/Aktionen/Ergebnisse | Erst gemeinsame Styles, danach Bausteine; keine parallele CSS-Schreibarbeit. |
| 3–7 | Tokens/Controls → PDF-Karten | Gleiche visuellen Zustände und Kontrastregeln. |
| 3–8 | Seitengerüst/Tokens → Info/404/Hinweise | Keine eigenständige zweite Designsprache. |
| 3–9 | Styles/Seitengerüst → Diff-/A11yreview | Tokenberechnung ersetzt keine Browserprüfung, R7. |
| 3–10 | Theme/Kontrast → finale visuelle Matrix | Hell/dunkel, Fokus, reduzierte Bewegung tatsächlich prüfen. |
| 4–5 | Rahmen/Navigation → Werkzeugseiten | Kein verlorener Platz für Arbeitsbereich bei 320 px. |
| 4–6 | Rahmen/Navigation → Tastatur-/Dateifokus | Fokusaktionen dürfen sich nicht gegenseitig verdecken. |
| 4–7 | Rahmen/Navigation → PDF-Seite | Gleiches Seitenraster, bestehende Route erhalten. |
| 4–8 | Footer/Katalog/Alt-URL → Informationsseiten | Links und Kopie synchron; gemeinsame Tests serialisieren. |
| 4–9 | Home-/Navigationstests → unabhängiger Review | Neue Navigation sachgerecht testen statt alte Struktur erzwingen. |
| 4–10 | Home-/Site-/Navigationstests → Browsermatrix | Keine doppelten bedeutungslosen Tests; vorhandene Fälle nutzen. |
| 5–6 | Bildlayouts → gemeinsame Bausteine/gleiche E2E-Dateien | Punkt 5 zuerst, danach Punkt 6; gemeinsame Tests nicht parallel ändern, R4. |
| 5–7 | Optionaler ToolWorkspace → PDF-Rahmen | Nur falls vorhanden übernehmen; kein zweiter Zustandsbesitzer. |
| 5–8 | Bildkomponenten → Korrektur von Servertexten | Textarbeit nach Layoutintegration, R4. |
| 5–9 | Erhaltene Optionen/Änderungshinweis → Paritätsreview | Ergebnis nach Optionswechsel gesondert prüfen. |
| 5–10 | Werkzeug-E2E → finale Bildmatrix | Mock-/Realnachweis trennen, R7. |
| 6–7 | Auswahl/Hinweise/Aktionen → PDF-Gestaltung | Gemeinsame Semantik zuerst; PDF-Lebenszyklus bleibt eigenständig. |
| 6–8 | notices.tsx und Serverhinweise → Textabgleich | Geteilte Hinweise erst nach Punkt 6 bearbeiten, R4. |
| 6–9 | Reset/Ablauf/Dateiliste → Lebenszyklusreview | Keine verspäteten Ergebnisse oder gültig wirkenden alten Links. |
| 6–10 | A11y-/Fehlerfälle → finale Matrix | Leere, fertige und fehlerhafte Zustände prüfen. |
| 7–8 | PDF-Seite/-Komponente → Text-/Betriebsabgleich | Punkt 7 vor Punkt 8; Signaturhinweise sachlich erhalten. |
| 7–9 | PDF-Varianten/Teilfehler → unabhängiger Review | Erfolge und Fehler je Variante bewerten. |
| 7–10 | PDF-/Serverfehler-/A11ytests → finale Matrix | Größere/gleiche Ergebnisse und Ablauf einbeziehen. |
| 8–9 | Texte/Informationslinks → Sachlichkeitsreview | Keine garantierte Einsparung oder erfundenen Rechtstexte. |
| 8–10 | Privacy-/Sitetests → abschließende sieben Seiten | Kompatible Alt-URL und No-JS-Information nachweisen. |
| 9–10 | Reviewberichte/release-review → Abschlussmatrix | Erst Befunde entscheiden; Korrekturen gezielt prüfen, dann abschließen, R4/R7. |

Es wurde kein Planmandat gefunden, das einen inhaltslosen Test oder wortgleich duplizierte Logik verlangt. Die ursprüngliche Ein-Commit-Regel, Freigabeformulierung und noch offene Runtimeannahmen wurden durch R1/R2/R5 aufgelöst. Geteilte Dateien sind vor Schreibarbeit zuzuweisen.

## Aufgabenstatus

| Punkt | Stand | Tatsächlicher Nachweis / nächster Schritt |
| --- | --- | --- |
| 1 | Dokumentationssetup erledigt; laufende Auditnachweise separat | Branch, Planfreigabe, Spec, vollständiger Preflight und Runtimebericht vorhanden. Vollständige Funktionsausführung noch nicht behauptet. |
| 2 | Abgeschlossen, unabhängig geprüft | Linux-/Codec-Gates und vier echte Werkzeugaufträge bestanden; Retryfix `eeb9fe9`, neun Valkey-Race-Tests und unabhängiger Review ohne Blocker in `7308f68`. [Nachweise](reviews/2026-11-03-linux-acceptance.md). |
| 3 | Abgeschlossen, unabhängig geprüft; Gesamtmatrix folgt | `40338c5`, `c5a456a`, `5254a2d`; Check/Build, Chromium Home/Site 12/12, Startseiten-Axe hell/dunkel 0 Verstöße; unabhängiger Review Spec compliant / Quality Approved. [Nachweis](reviews/task3-visual-system.md). |
| 4 | Implementiert; unabhängiger Review folgt | Desktoprail, kompakte native Auswahl, sichtbare H1 Werkzeuge, vier gleichrangige Aufgabenfelder und Footer. Gezielte Chromium-/WebKit-Nachweise grün; Gesamtmatrixgrenzen im [Bericht](reviews/task4-navigation.md). |
| 5 | Offen | Bildarbeitsbereiche mit Optionsparität angleichen. |
| 6 | Offen | Gemeinsame Auswahl, Status und Ergebnisse umsetzen. |
| 7 | Offen | PDF-Arbeitsbereich und Varianten angleichen. |
| 8 | Offen | Texte, Info/404 und Betriebsvertrag abgleichen. |
| 9 | Offen | Unabhängige Funktions-/Infrastrukturreviews. |
| 10 | Offen | Endgültige Nachweise und Übergabe. |

## Commitnachweise

| Teil | Commit | Inhalt und tatsächliche Prüfung |
| --- | --- | --- |
| 1a | `69916585b7367f248a3c1365ba6247adbc1333f4` | Freigabe/Branch/Teilcommit-Sequenzen. Ausgangsstatus und Isolation geprüft; `git diff --check` ohne Fehler. |
| 1b | `492b4c3b5f28aa4176f575ab5cdea85e934538a6` | Layout-, Zustands-, Paritäts- und Abnahmespezifikation. Quellenabgleich und acht sRGB-Kontrastpaare; `git diff --check` ohne Fehler. |
| 1c | `b19dc635b8b8d294a409fa9f7526737b175b5395` | Preflight, Baseline und Runtimebericht. Markdownlinks, alle zehn Aufgaben und 45 Aufgabenpaare geprüft; nur eigene freigegebene Dokumentationsdateien gestagt. |

Ein Commit kann seine eigene ID nicht enthalten. Für 1c liefert `git log -1 --format=%H -- docs/superpowers/progress.md` bis zum nächsten Fortschrittsupdate den ursprünglichen Einführungscommit; die Koordination ergänzt dessen feste ID vor einer weiteren Ledgeränderung.

Punkt 1 wurde unabhängig durch `review_setup` für den Bereich `0d35657..b19dc63` geprüft: Spec compliant, Quality Approved, keine wichtigen oder kleineren Befunde. Punkt 3: Tokens `40338c5`, Controls `c5a456a`; die feste ID des Shell-/Nachweiscommits folgt im nächsten regulären Ledgerupdate.


Punkt 4: Navigation `fcbb01f`, direkter Werkzeugkatalog `6193d79`; Footer-/Responsive-/Nachweiscommit über `git log -1 --format=%H -- docs/superpowers/reviews/task4-navigation.md` bestimmbar, feste ID beim nächsten regulären Ledgerupdate ergänzen. Check: 98 Dateien ohne Befund; Unit-Suite 410 bestanden, zehn übersprungen. Die beim parallelen Build gestörte volle Browsermatrix wird nicht als vollständig bestanden ausgewiesen.
