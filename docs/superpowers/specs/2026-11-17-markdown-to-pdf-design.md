# Markdown zu PDF

## Ziel und gewählter Ansatz

Die bestehende Website erhält ein Werkzeug zum Umwandeln hochgeladener Markdown-Dateien in herunterladbare PDFs. Der Nutzer hat den direkten PDF-Renderer als Ansatz gewählt. Bestehende serverseitige Sitzung, Uploads, Queue, isolierte Verarbeitung, Downloads und Löschung werden wiederverwendet.

Alternative: Markdown nach HTML und anschließend HTML/CSS nach PDF bietet mehr Layoutfreiheit, benötigt aber mehr Laufzeitabhängigkeiten und einen aufwendiger abgesicherten Ressourcenresolver. Der direkte Renderer begrenzt die benötigte Ausgabeoberfläche.

## Bedienung

Neue Seite `/pdf/markdown` mit dem Werkzeugtitel „Markdown zu PDF“, erreichbar über das bestehende Werkzeugverzeichnis. Eine Datei mit Endung `.md` oder `.markdown` auswählen, ausdrücklich „PDF erstellen“ starten, Fortschritt beziehungsweise Fehler anzeigen und genau eine PDF herunterladen. Auswählen allein startet keinen Upload. Entfernen fordert wie bei bestehenden Werkzeugen die Serverlöschung an.

## Ausgabe und unterstützte Inhalte

UTF-8 mit optionalem BOM. Überschriften, Absätze, geordnete und ungeordnete Listen, Zitate, sichere Links, Tabellen und Codeblöcke werden auf A4-Hochformat ausgegeben. Text bleibt auswählbar; eine eingebettete, lizenzierte Schrift unterstützt deutsche Umlaute und das lateinische Alphabet. Vollständige CJK- und Emoji-Abdeckung gehört nicht zur ersten Version; nicht darstellbare Zeichen dürfen den Auftrag nicht unkontrolliert abstürzen lassen. Tabellenzellen und lange Codezeilen werden umgebrochen. Mehrseitige Tabellen wiederholen ihre Kopfzeile.

HTML wird nicht ausgeführt oder als aktive Auszeichnung interpretiert. Bilder werden nicht geladen; ihre Alternativtexte erscheinen als Text. Keine lokalen Dateien, relativen Pfade, externen URLs oder Data-URLs als Bildressourcen auflösen. Nur Links mit `https`, `http` oder `mailto` dürfen als aktive PDF-Links ausgegeben werden. Kein benutzerdefiniertes CSS, JavaScript, Mermaid, LaTeX oder ZIP-Upload.

## Technische Integration

Neues serverseitiges Werkzeug `markdown-pdf`, Eingabeformat `markdown`, genau ein Ergebnis mit MIME `application/pdf` und bereinigtem ursprünglichem Dateistamm plus `.pdf`. Der API-Vertrag in `api/openapi.json` bleibt kanonisch; Browsertypen werden daraus generiert. Neue additive Datenbankmigration erweitert bestehende Werkzeug- und Formatconstraints. Bestehende Bild-, PDF-Komprimierungs- und Audiowerkzeuge behalten ihr Verhalten.

Python verwendet einen etablierten Markdown-Parser und einen direkten PDF-Renderer, bevorzugt markdown-it-py und ReportLab nach Eignungsprüfung. Abhängigkeiten werden exakt im bestehenden Lockfile festgelegt. Eine geeignete Schrift einschließlich Lizenz wird gebündelt. Parserimporte erfolgen weiterhin erst nach Sandboxaktivierung. Keine Umgehung der bestehenden Socket- oder Ressourcenlimits.

## Grenzen und Fehler

Vorgeschlagene Anfangswerte: maximal 2.097.152 Bytes Eingabe, 20.971.520 Bytes Ausgabe, 300 Seiten und 120 Sekunden Prozesslaufzeit; bestehendes Speicherlimit bleibt erhalten. Diese Werte sind Implementierungsentscheidungen, keine bereits vorhandenen Produkteigenschaften. UTF-8 wird vollständig geprüft; Binärdaten, leere beziehungsweise nur aus Leerraum bestehende Dateien und überschrittene Grenzen liefern verständliche Fehler. Die Dateiendung ersetzt keine Inhaltsprüfung. Temporäre oder unvollständige Ergebnisse werden nicht zum Download freigegeben.

## Nachweise

Python-Tests prüfen Syntax, Text und Seitenzahl mit unabhängigem PDF-Reader, Umlaute, lange Zeilen, mehrseitige Tabellen und Grenzen. Ressourcenreferenzen und HTML dürfen keine lokalen Inhalte oder Netzwerkzugriffe auslösen. Go-Tests prüfen Optionen, Annahme, Limits, Ergebnisname/MIME und Migration. Frontend- und E2E-Tests prüfen expliziten Start, Status, PDF-Download, Fehler und Löschung. Relevante bestehende Tests, Typprüfung, Build und Vertragsgenerierung werden ausgeführt; nicht ausführbare Prüfungen werden ausdrücklich dokumentiert.

## Umsetzung und offene Entscheidungen

Subagents implementieren nacheinander Renderer, Go/API-Integration und Frontend; unabhängige Reviews prüfen die jeweiligen Änderungen und abschließend den Branch. Der Controller integriert und prüft. Kein Push, Merge oder Deployment gehört zum Auftrag. Bibliotheksversionen, Schriftdatei und interne Hilfsfunktionen bestimmt die Umsetzung nach Prüfung des vorhandenen Codes und der offiziellen Dokumentation.
