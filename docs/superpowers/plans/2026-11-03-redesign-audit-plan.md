# Website-Redesign und Funktionsprüfung – genehmigter Ausführungsplan

> **Status: FREIGEGEBEN, 03.11.2026.** Der Nutzer hat die Umsetzung dieses Plans mit vielen Subagents beauftragt. Damit gilt die empfohlene Richtung „Dateiwerkstatt“ als gewählt. Die spätere ausdrückliche Anweisung, jeden Planpunkt in mehrere aussagekräftige, detailliert beschriebene Teilcommits zu zerlegen, ersetzt die frühere Ein-Commit-Regel. Die technischen Abnahmen bleiben an tatsächliche Nachweise gebunden.
>
> **Für ausführende Agenten:** Erst nach ausdrücklicher Freigabe ausschließlich durch Subagents gemäß Nutzerwunsch umsetzen; dafür `superpowers:subagent-driven-development` verwenden. Jeder Punkt erhält einen verantwortlichen Implementierer und einen davon unabhängigen Reviewer. Root koordiniert, integriert und prüft die Nachweise. Checklisten dokumentieren tatsächliche Ergebnisse; offene oder blockierte Prüfungen dürfen nicht als bestanden gelten.

**Ziel:** Alle vier vorhandenen Werkzeuge nachweisbar prüfen und eine eigenständige, konsistente Website gestalten, ohne bestehende Funktionen oder die direkte Werkzeugauswahl zu verlieren.

**Architektur:** Astro-Seiten und React-Werkzeuge bleiben erhalten. Die Gestaltung entsteht über gemeinsame Tokens und kleine wiederverwendbare Oberflächenbausteine; `useImageBatch` und die bestehende Go-JSON-API bleiben die Funktionsbasis. Backendänderungen erfolgen ausschließlich für reproduzierte Fehler, nicht als pauschale Wiederholung abgeschlossener Arbeit.

**Technik:** Astro, React, TypeScript, Tailwind; Go-API/Queue/Worker/Cleanup; PostgreSQL, Valkey sowie private Python-Codecs. Keine neue Bibliothek ist für diesen Vorschlag erforderlich.

**Spezifikationsgrundlage:** Benutzerauftrag „ausführlichen Plan zuerst“ mit anschließender Umsetzungsfreigabe, die konkretisierte [Dateiwerkstatt-Spezifikation](../specs/2026-11-03-file-workshop-design.md), aktuelle Quellen unter `src`, `server` und `converter`, `docs/go-backend-plan.md`, `docs/go-backend/architecture.md` und `docs/go-backend/release-review.md`. Historische Browser-only-Aussagen aus `docs/implementation-plan.md` und `docs/release-review.md` sind keine aktuellen Serveranforderungen. Ausführungsstand, Preflight und Commitnachweise werden im [Fortschrittsledger](../progress.md) geführt.

## Grenzen und bestehende Präferenzen

- Die einfache Startseite bleibt direkt bedienbar: kein großer Hero, keine Einleitungstextwand und kein Abschnitt „So funktioniert es“. Diese frühere ausdrückliche Vorgabe ist in `docs/go-backend-plan.md:32` und `:249` dokumentiert.
- Vorhandene URLs, vier Werkzeuge, Formatoptionen, tatsächliche Ergebnisgrößen, Zustände und Lösch-/Ablaufverhalten erhalten.
- Upload erst nach ausdrücklichem Start; kein automatischer Wechsel zur lokalen Verarbeitung. Hinweise beschreiben temporäre Serverspeicherung korrekt.
- Deutsch, Tastaturbedienung, verständliche Fehlermeldungen, Dark Mode und reduzierte Bewegung bleiben Pflicht.
- Bestehende CSP beachten: insbesondere keine unzulässigen Inline-Styles oder neuen fremden Netzquellen.
- Keine Pushes, Veröffentlichung, Nutzdaten-/Volumenlöschung oder erfundenen Betreiber-/Rechtstexte.
- Jeder Punkt erhält mehrere sinnvolle Teilcommits entsprechend der untenstehenden Sequenz. Keine leeren oder künstlich zerstückelten Commits, um eine Anzahl zu erreichen. Commitbodys beschreiben in vollständigen deutschen Sätzen Inhalt, Zweck und wirklich ausgeführte Prüfungen; Vorlagen sind keine Prüfnachweise.
- Umsetzung ausschließlich auf `redesign/file-workshop` im vorhandenen Checkout. Die dedizierte Branch schützt `main`; die bestehende installierte Windows-/Testumgebung und der IDE-Kontext bleiben verfügbar. Kein zusätzlicher Worktree, Merge oder Push. Änderungen anderer Agenten ausschließlich nach expliziter Dateizuständigkeit stagen.

## Beobachteter Bestand

`src/pages/index.astro` zeigt vier Karten nach Bilder/PDF und eine unsichtbare H1. `src/data/tools.ts` liefert denselben Werkzeugkatalog für Navigation und Startseite. `src/styles/global.css` definiert eine neutrale, Apple-nahe Gestaltung mit blauem Akzent, Pillenbuttons und weichen Karten. `src/layouts/BaseLayout.astro` liefert Skiplink, deutsche Metadaten und No-JS-Hinweis. `src/components/site/SiteHeader.astro` enthält operationenbezogene Dropdowns mit Hover, Klick, Escape und aktiver Seite; der Footer enthält Werkzeug- und Informationslinks.

`ImageConverter.tsx` verwendet eine Desktop-Zweispaltenansicht; `ImageCompressor.tsx` und `ImageResizer.tsx` ordnen den Ablauf linear an. Die gemeinsamen Bausteine heißen `DropZone.tsx`, `options.tsx`, `ActionBar.tsx`, `FileList.tsx` und `notices.tsx`. `PdfCompressor.tsx` hat einen eigenen Ablauf mit Aktionen innerhalb der Auswahlfläche sowie drei Ergebnisvarianten. Die Bildliste zeigt reale Maße, Größen, Fehler, Download und Ablaufzeit; eine Bildvorschau und ein Sammeldownload gehören nicht zum beobachteten Bestand und werden hier nicht neu verlangt.

Die Go-Arbeit G02–G13 ist implementiert. Es gibt keine belegte generische Liste fehlender Backendfeatures. Der historische Releasebericht nennt noch einen fehlenden abschließenden unabhängigen Infrastrukturreview und nicht ausgeführte GitHub-CI; aktuelle lokale Ergebnisse ersetzen diese Nachweise nicht automatisch.

## Bestätigte Prüfbaseline dieses Audits

| Prüfung | Beobachtung | Bedeutung |
| --- | --- | --- |
| `npm run check` | 96 Dateien, keine Fehler/Warnungen/Hinweise | Statische Frontendprüfung bestanden |
| `npm run build` | sieben statische Seiten erzeugt | Build bestanden; kein Beweis für Serverkonvertierung |
| `node scripts/generate-api-types.mjs --check` | Exit 0 | Generierte API-Typen aktuell |
| Python-Tests über vorhandene Umgebung | 168 bestanden, 13 übersprungen | Windows überspringt Linux-Sandbox-/O_NOFOLLOW-Prüfungen |
| `go vet ./...` | bestanden | Statische Go-Prüfung bestanden |
| native Windows-Go-Kurztests | Runner-Tests fehlgeschlagen | `server/internal/converter/runner_test.go` erzeugt Windows-Temppfade, während `protocol.go` POSIX-Pfade verlangt; Plattform-/Testharnessfrage, noch kein nachgewiesener Linux-Produktfehler |
| Docker | Linux-Daemon nicht erreichbar | Linux-Race-/DB-/Valkey-/Fullstack-Abnahme nicht erbracht |
| Statische Chromium-E2E für Home/Navigation/Site | 19 bestanden, ein absichtlicher Touch-Skip, 9,6 Sekunden | UI-Teilnachweis; keine echte Serverabnahme |
| `npm test` | nach ungefähr zwei Minuten ohne Ergebnisse abgebrochen | Ursache offen; weder bestanden noch bestätigter Produktfehler |
| Browser-Gesamtmatrix | Chromium verfügbar, Firefox/WebKit aktuell unbestätigt | In Punkt 10 vollständig nachweisen |

Diese Baseline wurde im Audit durch getrennte Prüfaufträge gemeldet. Die Gestaltung wurde anhand des Quellcodes untersucht; eine aktuelle manuelle visuelle Browserabnahme wird damit nicht behauptet.

## Gestaltungsalternativen und Empfehlung

1. **Dateiwerkstatt (empfohlen):** warme Papierflächen, dunkle Schrift, Petrol, klare Linien und ein gemeinsamer Arbeitsbereich. Schwerpunkt auf Dateiliste, Einstellungen und messbarem Ergebnis. Passt zu den vier sachlichen Werkzeugen und zur direkten Startseite.
2. **Technisches Kontrollpult:** kühles Grau/Indigo, kompakte Tabellen und ausgeprägte Messwertdarstellung. Gut für Stapelverarbeitung, aber technisch dichter und auf kleinen Bildschirmen anspruchsvoller.
3. **Grafisches Kreativstudio:** größere Typografie, Kategorieakzente und stärker gestaltete Werkzeugflächen. Markanter, beansprucht jedoch mehr Platz und Gestaltungsaufwand.

### Genehmigtes Zielbild der Dateiwerkstatt

- Startseite: kompakte sichtbare Überschrift „Werkzeuge“, vier gleichrangige Aufgabenfelder und kurze konkrete Beschreibungen; keine zusätzliche Marketingstrecke.
- Desktop: schmale Werkzeugnavigation und gemeinsamer Seitenkopf. Bilder links als Auswahl/Dateiliste, rechts Einstellungen und Hauptaktion auf ungefähr 320–360 px. PDF im gleichen Rahmen mit anschließendem Vergleich.
- Mobil: kompakte Werkzeugauswahl; Auswahl, Einstellungen, Start und Ergebnisse folgen derselben DOM-/Lesereihenfolge. Kein horizontaler Pflichtscroll und keine schwebende Aktion, die Ergebnisse verdeckt.
- Farbentwurf: Papier `#F6F4EF`, Fläche `#FFFFFF`, Schrift `#172B2A`, Sekundärschrift `#526461`, Aktion `#0F6B61`, Informationsfläche `#E4F0EC`. Dunkler Hintergrund `#101918`, Fläche `#182623`, helle Schrift und aufgehellter Akzent. Endgültige Kombinationen erst nach Kontrastprüfung festlegen.
- Vorhandene Systemschriften behalten. Seitentitel ungefähr 28–36 px, Abschnittstitel 18–22 px, Fließtext 16 px; Dateigrößen mit tabellarischen Ziffern. Kontrollen 8–12 px Radius, Panels 12–16 px; Schatten vor allem bei Überlagerungen.
- Zustände explizit gestalten: leer, Prüfung, bereit, Upload, Queue, Verarbeitung, Erfolg, Teilfehler, Fehler, abgelaufen und Serverausfall. Text bleibt neben Farbe/Symbol vorhanden. Fortschritt ausschließlich aus tatsächlichem Status ableiten.
- Ergebnisse zeigen Original/Ergebnis leichter vergleichbar, größere oder unveränderte Dateien ehrlich, Download und Ablaufzeit zusammen. Keine unbelegte Einspargarantie oder automatische Qualitätsempfehlung.

## Review-Schwerpunkte

1. Einstellungen ändern nach vorhandenem Ergebnis: alte Ergebnisse nicht als neu berechnet darstellen (Punkte 5–6).
2. Entfernen/Reset während Upload, Queue oder Verarbeitung: keine verspäteten Ergebnisse oder verbleibenden aktiven Downloads (Punkte 2, 6–7).
3. Teilfehler und größere Ergebnisse: erfolgreiche Downloads erhalten, Fehler zuordnen und keine Einsparung erfinden (Punkte 6–7).
4. Lange Dateinamen, viele Dateien, 320 px und 200 % Zoom: Aktionen bleiben erreichbar, kein abgeschnittener Pflichtinhalt (Punkte 4–7, 10).
5. Linux-Sandbox, DB-Queue, Valkey und Ablauf/Cleanup: echte Infrastruktur prüfen, Mocktests nicht als Fullstackbeweis verwenden (Punkte 2, 10).

## Geplante Arbeitspunkte und Commits

### Verbindliche Teilcommit-Sequenz

Die Commitgrenzen folgen prüfbaren Ergebnissen. Ein reproduzierter Fehler erhält einen gezielten Regressionstest und eine zugehörige Korrektur; ein unbelegter Fehler erzeugt keinen Produktpatch. Blockierte Prüfungen werden ehrlich dokumentiert. Die Zahl der Teilcommits darf bei zusätzlichen bestätigten Befunden steigen; sie darf nicht durch bedeutungslose Änderungen erzwungen werden.

| Punkt | Sinnvolle Teilcommits in Reihenfolge |
| --- | --- |
| 1 | (a) Freigabe, Branch und Teilcommit-Sequenz festhalten; (b) verbindliche Designspezifikation konkretisieren; (c) Ausgangsstand, Preflight und Fortschrittsledger sichern. Die getrennte Laufzeitdiagnose und Inventarnachweise ergänzen die Baseline bei Vorliegen. |
| 2 | (a) Linux-/Docker-Voraussetzungen und reproduzierbare Testbefehle nachweisen; (b) echte API-/Dateidurchläufe samt Lebenszyklus und tatsächlichen Ergebnissen dokumentieren beziehungsweise konkrete Blockaden festhalten; (c) Infrastrukturreview und gegebenenfalls bestätigte Regressionen abschließen. |
| 3 | (a) Hell-/Dunkel-Tokens und Typografieskala einführen; (b) gemeinsame Kontrollen und Zustände gestalten; (c) Seitengerüst/Theme-Metadaten und Kontrastnachweise vervollständigen. |
| 4 | (a) kompakte Werkzeugnavigation und aktive Route umsetzen; (b) direkte Startfelder und Footer aus bestehendem Katalog gestalten; (c) relevante Navigations-/Home-Nachweise und notwendige Regressionen ergänzen. |
| 5 | (a) gemeinsamen rein darstellenden Arbeitsbereich und Konverter einpassen; (b) Kompressor und Resizer mit erhaltenen Optionen angleichen; (c) Einstellungswechsel und responsive Durchläufe prüfen und belegen. |
| 6 | (a) Dateiauswahl und Start-/Statusdarstellung ordnen; (b) Dateiliste, Ergebnisvergleich und Ablauf verständlich gestalten; (c) Reset-/Entfernen-/Fehler- und Accessibilityfälle gezielt nachweisen. |
| 7 | (a) PDF-Auswahl und Aktionen in den gemeinsamen Ablauf einpassen; (b) Analyse und drei Varianten einschließlich Teilfehlern gestalten; (c) PDF-Lebenszyklus, Mobilbedienung und Regressionen nachweisen. |
| 8 | (a) Bild-/PDF-Texte und Serverhinweise sachlich korrigieren; (b) Informationsseite und 404 einschließlich kompatibler Alt-URL gestalten; (c) Text-/Datenschutzabgleich und Veröffentlichungsvoraussetzungen belegen. |
| 9 | (a) unabhängigen Funktions-/Gestaltungsreview dokumentieren; (b) unabhängigen Infrastrukturreview samt Befundentscheidung dokumentieren; (c) nur bei bestätigten notwendigen Korrekturen diese mit gezieltem Nachweis ergänzen. |
| 10 | (a) finale statische/Unit-/Build-/API-Typ-Nachweise festhalten; (b) Browser-/Viewport-/Theme-/Accessibilitymatrix dokumentieren; (c) Linux-/Fullstackstatus und belastbare Übergabe mit offenen Grenzen abschließen. |

**Ausführung:** Root koordiniert viele spezialisierte Subagents und unabhängige Reviews. Gleichzeitige Dateiarbeit wird durch abgegrenzte Zuständigkeiten vermieden; Git-Commits werden serialisiert. Nach Abschluss eines Teilcommits folgt seine ID ins Ledger. Die nachfolgenden Commitnamen und Bodys beschreiben den thematischen Rahmen und werden je tatsächlichem Teilumfang präzisiert.

Für die Funktionsmatrix gelten zusätzlich konkrete Grenzfälle: Bildstapel mit 30/31 Dateien; alle unterstützten Eingaben JPEG, PNG, WebP, GIF, BMP, ICO und AVIF sowie jede angebotene Ausgabe; Signatur-, Animations-, Größen-, Pixel- und Kantenlimits; gleiche Namen; Alpha/Hintergrund und ICO-Größen. Beim Resizer Einzel-/Doppelkante, Verhältnis an/aus, Prozent, Upscale und Originalformatsperren prüfen. Bei PDF beschädigte, verschlüsselte und unverkleinerbare Dateien einbeziehen. API-Ausfälle, 429 mit Retry-After, Netzunterbrechung und 5xx müssen verständliche deutsche Fehler liefern; keine stillen Upload-Wiederholungen. Cookies, CSRF, Same-Origin, fehlende Dateipersistenz in Browserstorage und Löschen prüfen. Axe auch für leere, fertige und fehlerhafte Zustände einsetzen. Diese Fälle gehören zu den jeweils zuständigen Punkten 2 sowie 5–8 und der abschließenden Matrix in Punkt 10; statische Preview besitzt keine API.

### 1. Bestand sichern, Fehler klassifizieren und Designentscheidung festhalten

**Abhängigkeit:** Umsetzungsfreigabe liegt vor; Dateiwerkstatt und Umfang sind im Plan und in der Designspezifikation festgehalten. **Dateien:** dieses Dokument; neu `docs/superpowers/specs/2026-11-03-file-workshop-design.md` nach Wahl der Richtung; aktuelle Prüfnotizen in `docs/go-backend/release-review.md` nur klar datiert ergänzen. Bestehendes `docs/handoff.md` unangetastet lassen.

- [ ] `git status --short` und vorhandene Änderungen erfassen; vor Änderungen einen isolierten Arbeitsstand vereinbaren/herstellen, keine fremden Änderungen verwerfen.
- [ ] Vier Werkzeuge gegen Optionen, API-Aufrufe, Lebenszyklus und bestehende Tests inventarisieren. Jeden Fehler mit Reproduktion, Erwartung und Beobachtung erfassen; historische Aufgaben nicht allein wegen ihres Alters erneut öffnen.
- [ ] Vor Produktarbeit den `npm test`-Hänger zeitlich begrenzt diagnostizieren: zunächst maximal zehn Minuten für Prozess-/Browserstart, Vitest-Konfiguration und einen gezielt ausgewählten vorhandenen Test einsetzen; Ergebnis, Timeout und nächste belegte Hypothese dokumentieren. Keine pauschale Regeldeaktivierung, keine still entfernten Tests. Ein hängender Lauf ist kein bestandener Test und rechtfertigt noch keinen Produktpatch; bei ungelöster Ursache verbleibt die Testbaseline ausdrücklich unbestätigt.
- [ ] Gewählte Gestaltung als Spezifikation mit konkretem Layout, Zuständen und Abnahme festhalten; bei Abweichung vom Vorschlag folgende Punkte entsprechend aktualisieren.

**Abnahme:** nachvollziehbarer Ausgangsstand, vollständige Funktionsmatrix, genehmigte Richtung; keine unbestätigte Backendfehlfunktion als feststehend behauptet.

**Thematischer Commitrahmen (mehrere Teilcommits gemäß Sequenz):** `docs: record approved redesign scope and audit baseline`

**Commitbody:** „Dokumentiert die gewählte Gestaltungsrichtung, erhaltene Funktionen und reproduzierte beziehungsweise noch ungeprüfte Befunde. Trennt historische Browserverarbeitung vom aktuellen Go-Betrieb, damit keine bereits erledigte Migration wiederholt wird. Prüfung: dokumentierte Befehle und tatsächliche Ergebnisse aufführen; Freigabe und bekannte Infrastrukturblockaden ausdrücklich nennen.“

### 2. Linux-Backend und echte Dateiverarbeitung nachweisen

**Abhängigkeit:** erreichbarer Linux-Docker-Daemon; unabhängig von der visuellen Umsetzung. **Dateien:** `server/compose.test.yaml`, `server/README.md`, `docs/go-backend/release-review.md`, `docs/go-backend/operations.md`; Produktdateien unter `server`/`converter` nur bei reproduziertem Fehler und mit zugehörigem Regressionstest.

- [ ] Docker-Erreichbarkeit prüfen. Bei fehlendem Daemon Blockade dokumentieren und keine Infrastrukturabnahme behaupten.
- [ ] Gemäß `server/README.md`: `docker compose -f server/compose.test.yaml up -d --wait db valkey`, anschließend `docker compose -f server/compose.test.yaml run --rm go go vet ./...` und `docker compose -f server/compose.test.yaml run --rm go go test -race ./...` ausführen.
- [ ] Python-Tests einschließlich Linux-spezifischer Sandbox-/O_NOFOLLOW-Fälle in der vorgesehenen Linux-Umgebung ausführen. Windows-Skips nicht als Linux-Erfolg werten.
- [ ] Windows-Runner-Abweichung isolieren: POSIX-Produktvertrag gegen Testpfade prüfen. Nur falls Windows-Ausführung unterstützt werden soll, einen gezielten Testharness-/Dokumentationspatch ableiten; POSIX-Sicherheit nicht pauschal lockern.
- [ ] `docker compose up -d --build --wait` und dokumentierte echte Serverprüfungen gegen API, Sitzung/CSRF, Queue, Rate-Limits, Abbruch, Ablauf, Cleanup und Recovery durchführen. PostgreSQL-/Valkey-Verhalten tatsächlich erreichen.
- [ ] Je ein reales Bild konvertieren, komprimieren und skalieren sowie ein reales PDF in drei Varianten verarbeiten; Downloads öffnen und Format, Dimensionen beziehungsweise PDF-Lesbarkeit und gemeldete Größen prüfen. Teilfehler, nicht unterstützte Eingaben und Limits zusätzlich prüfen.

**Abnahme:** Linux-Tests und echte vier End-to-End-Aufgaben bestanden; unabhängiger Infrastrukturreview berücksichtigt. Bei bestätigtem Fehler minimaler Patch plus Regression; bei ausbleibendem Fehler ausschließlich Nachweisdokumentation. Keine neuen Backendfeatures aus Vermutung.

**Thematischer Commitrahmen (mehrere Teilcommits gemäß Sequenz):** `test: document Linux backend and conversion acceptance`

**Commitbody:** „Hält die reproduzierbare Linux-Abnahme von Go, privaten Python-Codecs und echtem Dateidurchlauf fest; enthält ausschließlich gegebenenfalls dabei bestätigte, eng begrenzte Korrekturen. Begründung: Windows-Prüfungen und statischer Frontendbuild decken Sandbox, Datenbank, Valkey und Downloads nicht vollständig ab. Prüfung: exakte Befehle, Ergebnisse, Dateifälle und verbleibende Blockaden aufführen.“

### 3. Gemeinsames Gestaltungssystem einführen

**Abhängigkeit:** Punkt 1. **Dateien:** `src/styles/global.css`, `src/layouts/BaseLayout.astro`, bei freigegebener Markenanpassung `public/favicon.svg`.

- [ ] Genehmigte Farben, Schriftgrößen, Abstände, Radien und Flächen in zentralen Tokens abbilden; vorhandene semantische Klassen als Schnittstelle weiterverwenden.
- [ ] Buttons, Felder, Hinweise, Badges, Dropzone und Ergebnisse einschließlich disabled/focus/error/dark/reduced-motion gestalten.
- [ ] Theme-Metadaten und Seitengerüst anpassen. CSP und rein lokale Systemschriften erhalten.
- [ ] `npm run check` und `npm run build` ausführen; kontrastkritische Kombinationen prüfen und vorhandene axe-Prüfung ohne pauschale Regeldeaktivierung nutzen.

**Abnahme:** Text mindestens 4,5:1, große Schrift 3:1, erforderliche Kontroll-/Fokuskontraste 3:1; alle vorhandenen Bedienelemente erkennbar, hell/dunkel lesbar.

**Thematischer Commitrahmen (mehrere Teilcommits gemäß Sequenz):** `style: introduce the file workshop visual system`

**Commitbody:** „Ersetzt die bisherige visuelle Sprache durch die freigegebenen gemeinsamen Tokens und Bedienelemente. Zentralisiert Farben, Typografie und Zustände für eine konsistente Gestaltung aller Werkzeuge. Prüfung: Typecheck, Build, Kontrast- und Fokusprüfung mit tatsächlichem Ergebnis nennen.“

### 4. Werkzeugnavigation und direkte Startseite neu gestalten

**Abhängigkeit:** Punkt 3. **Dateien:** `src/components/site/SiteHeader.astro`, `SiteFooter.astro`, `src/pages/index.astro`, bei Bedarf `src/data/tools.ts`; Tests `e2e/home.spec.ts`, `navigation.spec.ts`, `site.spec.ts`.

- [ ] Bestehende vier Katalogeinträge als einzige Datenquelle erhalten. Neue kompakte Navigation und direkte Werkzeugfelder gemäß freigegebener Richtung bauen.
- [ ] Sichtbaren kompakten Seitentitel, aktive Seite und verständliche Links umsetzen; keine Hero-/Anleitungsstrecke ergänzen.
- [ ] Bestehende Maus-/Tastatur-/Touchfälle, Escape, Fokusverlust und Außenklick prüfen und passende Tests an tatsächliche neue Navigation anpassen.
- [ ] Startseite und Navigation bei 320 px, langen Labels, 200 % Zoom sowie ohne JavaScript prüfen.

**Abnahme:** alle vier Werkzeuge und Verarbeitungshinweis erreichbar; kein toter Link, kein verdecktes Menü, keine notwendige horizontale Scrollfläche.

**Thematischer Commitrahmen (mehrere Teilcommits gemäß Sequenz):** `feat: redesign direct tool selection and navigation`

**Commitbody:** „Führt die neue Werkzeugnavigation und kompakte Startauswahl ein und erhält alle vorhandenen URLs. Bewahrt die ausdrücklich gewünschte direkte Startseite ohne Marketingstrecke. Prüfung: Home-/Navigationsfälle, Tastatur, mobile Breite und Zoom mit Ergebnissen nennen.“

### 5. Arbeitsbereiche der drei Bildwerkzeuge vereinheitlichen

**Abhängigkeit:** Punkt 3; Punkt 4 kann separat geprüft werden. **Dateien:** `src/components/tools/ImageConverter.tsx`, `ImageCompressor.tsx`, `ImageResizer.tsx`; nur falls nötig neuer rein darstellender `ToolWorkspace.tsx` im selben Ordner. Tests `e2e/convert.spec.ts`, `compress.spec.ts`, `resize.spec.ts`.

- [ ] Einheitliche Bereiche Auswahl, Einstellungen, Start und Ergebnisse mit gleicher Lesereihenfolge umsetzen. Desktop-Zweispaltenlayout, mobil linear.
- [ ] `useImageBatch` und vorhandene Optionen unverändert anbinden: Konverterformate/ICO, Kompressionsqualität/maximale Kante, Prozent-/Pixelresize, Seitenverhältnis und erlaubte Vergrößerung.
- [ ] Alle formatabhängigen Kontrollen sowie „Wie Original“ erhalten; geänderte Einstellungen nach vorhandenem Ergebnis weiterhin kenntlich machen.
- [ ] Je Werkzeug mindestens erfolgreichen Durchlauf, ungültige Eingabe, geänderte Einstellung und mobile Bedienung mit bestehenden Tests prüfen.

**Abnahme:** keine verlorene Option; keine Umstellung des API-Vertrags; gleiche Aufgabensequenz und erreichbare Hauptaktion auf allen drei Seiten.

**Thematischer Commitrahmen (mehrere Teilcommits gemäß Sequenz):** `refactor: unify image tool workspace layouts`

**Commitbody:** „Gleicht die Arbeitsbereiche der Bildwerkzeuge an und bewahrt ihre jeweiligen Einstellungen und Batch-Verarbeitung. Reduziert unterschiedliche Bedienabläufe und lange mobile Suchwege. Prüfung: Konvertierungs-, Kompressions- und Skalierungsfälle einschließlich Einstellungswechsel aufführen.“

### 6. Auswahl, Status und Bildergebnisse überarbeiten

**Abhängigkeit:** Punkt 5. **Dateien:** `DropZone.tsx`, `options.tsx`, `ActionBar.tsx`, `FileList.tsx`, `notices.tsx` unter `src/components/tools`; vorhandene bildbezogene E2E- und Accessibilitytests.

- [ ] Dateiannahme und Grenzwerte kompakt gestalten; Uploadhinweis vor dem Start sichtbar zuordnen. Fokusmanagement und echte beschriftete Dateiinputs erhalten.
- [ ] Statusdarstellung für Prüfung, Upload, Queue, Verarbeitung, Fehler und Erfolg vereinheitlichen; nur tatsächliche Fortschrittswerte anzeigen.
- [ ] Original-/Ergebnisgröße, Dimensionen, Prozentänderung, größere/gleiche Ergebnisse, Download und Ablaufdatum klar gruppieren. Lange Dateinamen umbrechen/zugänglich vollständig anbieten.
- [ ] Mehrfachauswahl, Drop, gleiche Datei erneut, zu viele/ungeeignete Dateien, Serverausfall, Entfernen/Reset während laufender Arbeit, Ablauf und Fokus nach Entfernen prüfen.

**Abnahme:** keine verspätete Ergebnisanzeige nach Reset; keine gültig dargestellten abgelaufenen Downloads; größere Ergebnisse ehrlich markiert; kein neu verlangter Sammeldownload oder Vorschauumfang.

**Thematischer Commitrahmen (mehrere Teilcommits gemäß Sequenz):** `feat: clarify file selection and image result states`

**Commitbody:** „Ordnet Dateiauswahl, Einstellungen und reale Ergebnisdaten im neuen Gestaltungssystem. Macht Serverstatus, größere Ausgaben und Downloadablauf leichter erkennbar und erhält die Fokusführung. Prüfung: Auswahl-, Lebenszyklus-, Fehler-, Ablauf- und Accessibilityfälle mit Resultaten nennen.“

### 7. PDF-Werkzeug in den gemeinsamen Ablauf einpassen

**Abhängigkeit:** Punkte 3 und 6 für gemeinsame Gestaltung. **Dateien:** `src/components/tools/PdfCompressor.tsx`, `src/pages/pdf/komprimieren.astro`; Tests `e2e/pdf.spec.ts`, `server-errors.spec.ts`, `accessibility.spec.ts`.

- [ ] Auswahl, Start und Reset visuell trennen und im gemeinsamen Rahmen zeigen; weiterhin genau eine PDF und drei berechnete Varianten.
- [ ] Originalanalyse, Seiten-/Bildangaben, echte Serverfortschritte und Ergebniszustände beibehalten. Varianten gleich strukturiert und mobil untereinander darstellen.
- [ ] Hinweise zu Signaturen, verschlüsselten PDFs, unveränderten Bildern und nicht garantierter Einsparung passend sichtbar machen, ohne unbelegte Aussagen hinzuzufügen.
- [ ] Erfolgreiche drei Varianten, Teilfehler, komplette Ablehnung, Abbruch, Reset während Upload/Queue, Ablauf und größere/gleiche Ausgaben testen.

**Abnahme:** jeder Download gehört eindeutig zur Variante; Teilerfolge bleiben nutzbar; keine pauschale Erfolgsanzeige bei Fehlervarianten; keine neue fiktive Kompressionsstufe.

**Thematischer Commitrahmen (mehrere Teilcommits gemäß Sequenz):** `feat: align PDF compression with the shared workspace`

**Commitbody:** „Integriert PDF-Auswahl, Verarbeitung und Variantenvergleich in die gemeinsame Oberfläche. Bewahrt echte Analysewerte und zeigt Teilerfolge, Fehler und Ablauf je Auftrag verständlich. Prüfung: PDF-Erfolg, Teilfehler, Abbruch, Reset und Ablauf mit echten beziehungsweise klar benannten Mocknachweisen aufführen.“

### 8. Seitentexte und Informationsseiten mit aktuellem Betrieb abgleichen

**Abhängigkeit:** Punkte 4–7. **Dateien:** `src/pages/bilder/*.astro`, `src/pages/pdf/komprimieren.astro`, `src/pages/lokale-verarbeitung.astro`, `src/pages/404.astro`, `src/components/tools/notices.tsx` sowie betroffene „Der Server“-Texte in Bildkomponenten; Tests `e2e/privacy.spec.ts`, `site.spec.ts`.

- [ ] Bestätigte Textreste wie „kann Der Server“ korrigieren. „Ihre Bilder bleiben auf dem Server“ durch zutreffende temporäre Speicherung mit Ablauf ersetzen.
- [ ] Informationsseite und Footer gegen tatsächliche Upload-, Sitzungs-, Lösch- und Speicherverträge prüfen; historische Route `/lokale-verarbeitung` kompatibel erhalten.
- [ ] Unterstützte Formate und Grenzen ausschließlich aus aktuellem Vertrag ableiten; keine lokale Verarbeitung versprechen.
- [ ] 404 und Informationsseite gestalten; fehlende reale Betreiber-/Rechtsangaben als Veröffentlichungsvoraussetzung dokumentieren statt zu erfinden.

**Abnahme:** konsistente deutsche Texte, funktionierende Alt-URL, keine falsche Zusicherung über Netzwerk, Speicherung oder garantierte Dateiverkleinerung.

**Thematischer Commitrahmen (mehrere Teilcommits gemäß Sequenz):** `fix: align processing copy with current server behavior`

**Commitbody:** „Korrigiert belegte Formulierungsfehler und gleicht die Verarbeitungshinweise mit dem aktuellen Serverbetrieb ab. Verhindert missverständliche Aussagen zur Speicherung und hält bestehende Informationslinks kompatibel. Prüfung: Textabgleich, Informations-/404-Seiten und Datenschutz-E2E mit Ergebnissen nennen.“

### 9. Unabhängiges Funktions- und Änderungsreview durchführen

**Abhängigkeit:** Punkte 2–8. **Dateien:** `docs/go-backend/release-review.md`, neu `docs/superpowers/reviews/2026-11-03-redesign-review.md`; notwendige Korrekturen nur an konkret beanstandeten Dateien plus zuständigem Regressionstest.

- [ ] Gesamtdiff gegen freigegebene Spezifikation und Funktionsmatrix lesen; API-, Hook- und Sicherheitsänderungen besonders überprüfen.
- [ ] Infrastrukturreview separat auf Queue-/Cleanup-/Rate-Limit-/Sandbox-Grenzen richten; visuelle Verbesserung ist kein Ersatz dafür.
- [ ] Jeden Befund mit Datei, Reproduktion, Auswirkung und erforderlicher Korrektur einordnen; ausschließlich bestätigte relevante Fehler beheben.
- [ ] Korrigierte Fälle gezielt erneut prüfen; offene Einschränkungen im Reviewbericht benennen.

**Abnahme:** keine unbehandelten blockierenden Befunde; nachvollziehbarer unabhängiger Reviewnachweis. Routinewünsche außerhalb des Umfangs nicht als Abschlussbedingung hinzufügen.

**Thematischer Commitrahmen (mehrere Teilcommits gemäß Sequenz):** `chore: resolve and document redesign review findings`

**Commitbody:** „Dokumentiert das unabhängige Funktions-, Oberflächen- und Infrastrukturreview und enthält nur daraus bestätigte notwendige Korrekturen. Stellt sicher, dass die neue Gestaltung Funktionsparität und Sicherheitsgrenzen bewahrt. Prüfung: Reviewumfang, bestätigte Befunde, gezielte Regressionstests und verbleibende Grenzen aufführen.“

### 10. Gesamtabnahme und belastbare Übergabe abschließen

**Abhängigkeit:** alle vorherigen Punkte; Linux-Blockade muss für vollständigen Abschluss aufgelöst sein. **Dateien:** vorhandene Tests unter `e2e` nur für belegte Abnahmelücken; `docs/go-backend/release-review.md`, `docs/superpowers/reviews/2026-11-03-redesign-review.md` und dieser Plan für Nachweise. Keine beiläufige Produktänderung.

- [ ] `npm run check`, `npm test`, `npm run build`, `npm run test:e2e` und `node scripts/generate-api-types.mjs --check` erfolgreich ausführen. Hänger/Ursachen separat untersuchen; keine Tests still entfernen oder Regeln pauschal deaktivieren.
- [ ] Playwright-Projekte Chromium, Firefox, WebKit und mobile aus `playwright.config.ts` prüfen. Statische Preview-Tests klar von echten Serverläufen unterscheiden: in PowerShell vor dem echten Serverlauf `$env:E2E_BASE_URL = 'http://localhost:8080'` setzen und anschließend `npm run test:e2e` ausführen; für einen späteren Preview-Lauf die Variable mit `Remove-Item Env:E2E_BASE_URL` entfernen. Tests mit API-Mocks bleiben auch bei gesetzter URL Mocknachweise; echte Dateidurchläufe separat belegen.
- [ ] Linux-Nachweise aus Punkt 2 am finalen Stand bestätigen; echte vier Aufgaben erneut nur soweit Änderungen oder offene Bedenken dies erfordern. GitHub-CI-Ergebnis separat ausweisen, wenn sie tatsächlich ausgeführt wurde.
- [ ] Alle sieben Seiten bei 320/390/768/1440 px, hell/dunkel, Tastatur, 200 % Zoom und reduzierter Bewegung visuell prüfen. Screenshots zur Prüfung erzeugen, nicht ungefragt als Produktassets aufnehmen.
- [ ] Abschlussmatrix mit Funktionen, Nachweisen, geprüften Browsern, Skips und Grenzen ausfüllen; verbleibende Betreiber-/Rechtstexte vor Veröffentlichung ausdrücklich nennen. Kein Deployment ohne Auftrag.

**Abnahme:** Funktionen und Gestaltung nachgewiesen, keine ungeklärten Regressionen; blockierte Linux-/Fullstackprüfung verhindert die Behauptung einer vollständigen technischen Abnahme. Nutzer erhält konkrete Prüfergebnisse und nachvollziehbare verbleibende Grenzen.

**Thematischer Commitrahmen (mehrere Teilcommits gemäß Sequenz):** `docs: record final redesign and full-stack acceptance`

**Commitbody:** „Hält die finale Abnahme der vier Werkzeuge, sieben Seiten und responsiven Gestaltung fest. Trennt statische Prüfungen, Browser-Mocks, echte Go-Serverdurchläufe und unabhängiges Review, damit der Abschluss belastbar ist. Prüfung: tatsächliche Befehle, Zählwerte, Browser/Ansichten, Skips, CI-Status und verbleibende Veröffentlichungsvoraussetzungen aufführen.“

## Freigabe und Stoppregel

Richtung und Plan sind zur Umsetzung freigegeben. Alternative Gestaltung oder geänderte Anforderungen führen zuerst zur Plananpassung. Nach erfüllten Abnahmekriterien endet die Arbeit ohne neue Funktionen, zusätzlichen Infrastrukturumbau oder öffentliche Veröffentlichung. Einzelne erledigte Teilaufgaben und offene Nachweise stehen im Fortschrittsledger; eine dokumentierte Freigabe behauptet noch keine Produkt- oder Infrastrukturabnahme.
