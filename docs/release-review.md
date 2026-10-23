# Abschlussprüfung des ersten Releases

Geprüft am 23.10.2026 auf Branch `release/v1`.

## Umfang

Astro/React/TypeScript/Tailwind, statisch: Bilder konvertieren, komprimieren und skalieren sowie PDF-Komprimierung in drei tatsächlich berechneten Varianten. Keine Uploads oder persistente Speicherung von Nutzerdateien, kein Backend, Deployment oder Push.

## Vollständige Prüfung

`npm run verify` unter Node 24.21.0 vollständig mit Exit 0 ausgeführt:

| Prüfung | Ergebnis |
| --- | --- |
| Astro-/TypeScript-Check | 89 Dateien, 0 Fehler, 0 Warnungen, 0 Hinweise |
| Browser-Unit-Tests | 42 Testdateien, 410 bestanden, 10 abhängig von Browserfähigkeiten übersprungen |
| Produktionsbuild | 7 statische Seiten erfolgreich erzeugt |
| Playwright-E2E | 136 bestanden in Chromium, Firefox, WebKit und mobilem Chromium |

Die übersprungenen Unit-Fälle betreffen vorhandene/fehlende Encoder- und OffscreenCanvas-Fähigkeiten; alternative Fehlerpfade werden geprüft. Die E2E-Runde enthält 16 axe-Prüfungen ohne deaktivierte Regeln. Die zuvor sporadischen Firefox-Context-close-Probleme traten im vollständigen Abschlusslauf nicht auf.

Start-, Konverter- und PDF-Seiten wurden zusätzlich als Screenshots des Produktionsbuilds visuell geprüft. Testartefakte sind nicht Teil der Commits.

## Unabhängige Reviews

Drei Subagents haben Kern, Oberflächen und Querschnittstests bearbeitet und jeweils fremde Bereiche geprüft. Der Hauptagent hat Änderungen integriert, separat gelesen und gezielt committet.

- Bildkern/erweiterte Formate: Decoder-/Worker-Vertrag, ICO-Größen, BMP-Grenzen und Browser-Tests geprüft.
- Bildoberflächen: Originalformat im gemischten Stapel, Resize-Regeln, Qualitätswirkung, Fokus, Reset und Ressourcen geprüft.
- PDF-Kern/-Oberfläche: Masken und Spezialfarbräume konservativ unverändert; Worker-Transportfehler, Ressourcen, Status, echte Größen, Signaturhinweis und sichere Namen geprüft.
- Datenschutz/Bedienbarkeit: Kontext-Netzwerkbeobachtung, Window-Speicheraudit, statischer Worker-Audit, Tastatur, mobile Ergebnisse und axe-Prüfungen.
- Dokumentation mit tatsächlichem Verhalten und Grenzen abgeglichen.

Die Abschlussreviews meldeten keine weiteren bestätigten Produktfehler. Gefundene Fehler wurden vor dem jeweiligen Arbeitspunkt-Commit behoben. Die Übergabedatei bleibt absichtlich uncommittet.

## Verbleibende Grenzen

- PDF-Komprimierung braucht OffscreenCanvas im Worker. Ohne diese Fähigkeit zeigt die Anwendung einen Hinweis; sie behauptet keine erfolgreiche Komprimierung.
- Nicht unterstützte PDF-Bilder und Schriften bleiben unverändert. Einsparungen sind nicht garantiert; Signaturen werden ungültig und PDF/A-Konformität wird nicht garantiert.
- Browser-Speicherlimits sind best effort, keine harte Obergrenze für den PDF-Parser. Freigegebene Referenzen erzwingen keine sofortige Speicherbereinigung.
- WebKit unter Windows ist kein vollständiger Ersatz für Safari/iOS. Native Selects erzeugen dort einen nachgewiesenen CSP-Testbrowser-Effekt; nur der exakt eingegrenzte Event wird im Test ausgenommen. Die Anwendungs-CSP bleibt streng.
- Runtime-Speicheraudits erfassen das Fenster; Worker-Quellcode wird ergänzend statisch geprüft. Das ist kein formaler Sicherheitsbeweis.
- Echte Betreiber-/Rechtstexte und Hosting-Konfiguration sind vor Veröffentlichung separat zu ergänzen.
