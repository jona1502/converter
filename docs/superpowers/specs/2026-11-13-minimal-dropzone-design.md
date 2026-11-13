# Minimalistische Oberfläche mit zentraler Dropzone – Design

**Stand:** 13.11.2026. **Branch:** `design/minimal` (von `design/muhr-industries` = PR #2, zusätzlich `feature/audio-convert` = PR #4 eingemergt). **Worktree:** `../converter-minimal`.

## Ziel (Nutzerwunsch)

Sehr minimalistisch. Die Seitenleiste mit „Alle Werkzeuge“ entfällt. Vorbild für den **Ablauf** (nicht für Optik oder Inhalte) ist freeconvert.com/de:

- Auf der Startseite gibt es nur eine große Fläche zum Ablegen oder Auswählen von Dateien. Danach werden passende Optionen vorgeschlagen.
- Alternativ wählt man oben in der Navigationsleiste unter „Konvertieren“ usw., was möglich ist.

Die Optik bleibt Muhr-Industries: dunkel als Standard, hell per Umschalter, Mint-Akzent, Haarlinien. Logo, Texte und Layout von freeconvert werden nicht kopiert, es gibt auch keine Werbeflächen, kein Login und keine Preise.

## Aufbau

### Kopfzeile (alle Seiten)

- Links das Logo „MI converter“, es führt zur Startseite.
- In der Mitte bzw. links daneben Menüs mit Dropdown:
  - **Konvertieren ▾**: Bilder konvertieren, Audio konvertieren
  - **Komprimieren ▾**: Bilder komprimieren, PDF komprimieren
  - **Skalieren ▾**: Bilder skalieren
  - Die Einträge kommen aus `src/data/tools.ts` (Katalog als einzige Datenquelle). Die Gruppierung nach Aktion wird dort ergänzt, nicht hartkodiert.
- Rechts der Theme-Umschalter.
- Mobil: ein Menü-Button öffnet dieselben Gruppen als einfache Liste.
- Dropdowns sind per Tastatur bedienbar: Button mit `aria-expanded`, Escape schließt, Fokus kehrt zurück, Klick außerhalb schließt. Kein Hover-Zwang.
- Die bisherige Seitenleiste bzw. der `tool-picker` und „Alle Werkzeuge“ entfallen vollständig.

### Startseite `/`

- Zentriert: Titel (z. B. „Dateien umwandeln“), ein Satz Erklärung, eine große Dropzone mit Button „Dateien auswählen“ und eine kleine Zeile mit den Grenzen.
- Nach Auswahl oder Ablegen erkennt der Browser den Typ, ohne Upload, mit den vorhandenen Signaturprüfungen (Bild, PDF, Audio). Danach erscheinen passende Aktionen als Buttons:
  - Bild: „Konvertieren“, „Komprimieren“, „Skalieren“ (bei Konvertieren direkt mit Zielformat-Auswahl im Werkzeug)
  - PDF: „Komprimieren“
  - Audio: „Konvertieren“
  - Unbekannt oder gemischt: klare Meldung. Bei gemischten Typen werden Aktionen je Gruppe angeboten oder nur die gemeinsame Gruppe; die einfachste verständliche Lösung genügt.
- Nach Wahl einer Aktion wird das bestehende Werkzeug **auf derselben Seite** mit den gewählten Dateien gerendert. Die URL bleibt `/`, ein optionaler Hash wie `#bilder-konvertieren` ist erlaubt. Mit „Andere Datei“ oder „Zurück“ kehrt man zur Dropzone zurück.
- **Datenschutzregel:** Dateien niemals in localStorage, sessionStorage, IndexedDB oder Cache ablegen, um sie an eine andere Seite zu übergeben. Daher die Übergabe im selben React-Baum. Upload erst nach ausdrücklichem Start im Werkzeug, wie bisher.
- Unter der Dropzone höchstens eine schlichte Liste der Werkzeuge als Textlinks; keine großen Karten.

### Werkzeugseiten

- Bleiben als direkte Ziele der Navigation (`/bilder/konvertieren` usw.).
- Gleicher minimalistischer Rahmen: Titel, ein Satz, darunter das Werkzeug.

### Technik

- Werkzeugkomponenten (`ImageConverter`, `ImageCompressor`, `ImageResizer`, `PdfCompressor`, `AudioConverter`) bekommen eine optionale Prop `initialFiles?: File[]` (oder ein gleichwertiges Muster). Damit übernehmen sie Dateien, als wären sie über die eigene Dropzone gekommen, inklusive derselben Vorprüfung. Ohne Prop verhalten sie sich unverändert.
- Die Startseite ist eine React-Insel (`client:load`) mit Zustand `select → choose → tool`.

## Nicht-Ziele

- Keine Änderung an Backend, API und Werkzeuglogik (außer `initialFiles`).
- Keine Werbung, kein Login, keine Suche.
- Kein Wechsel der Farbtokens; Feinschliff an Abständen und Typografie für den minimalistischen Eindruck ist erlaubt.

## Abnahme

- `npm run check`, `npm test`, `npm run build` grün.
- Playwright mit API-Doubles:
  - Startseite: Bild ablegen, Aktionen sichtbar, „Komprimieren“ zeigt das Werkzeug mit der Datei, ohne Upload vor dem Start
  - dasselbe für PDF und Audio
  - unbekannter Typ zeigt eine Meldung
  - Navigation per Tastatur
  - axe ohne Verstöße bei 390 und 1440 px, dunkel und hell
- Bestehende e2e-Tests, die die Seitenleiste oder die alte Startseite prüfen, werden auf das neue Verhalten umgestellt, nicht gelöscht. Jede Anpassung wird im Commit begründet.
- Fehlschläge, die ein Backend brauchen, sind identisch mit dem Ausgangsstand.
