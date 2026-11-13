# Fix-Spezifikation: Datei ablegen und direkt Zielformat wählen

Stand: 13.11.2026. Status: Entwurf für die spätere Umsetzung.

## Gewünschter Ablauf

Die bereitgestellten Website-Screenshots dienen als Referenz für den Ablauf: Erst wird eine Datei abgelegt oder ausgewählt. Anschließend sieht man die Datei und kann direkt auswählen, in welches unterstützte Format sie konvertiert werden soll.

1. Die Startseite zeigt eine zentrale Dropzone mit „Dateien auswählen“.
2. Drag-and-drop und Dateiauswahl führen in dieselbe Dateiliste auf derselben Seite.
3. Jede Datei erscheint mit Dateiname, Dateigröße, erkanntem Eingabeformat und einer Entfernen-Schaltfläche.
4. Für konvertierbare Dateien steht direkt an der Dateizeile „Ausgabe“ mit einer Auswahl passender Zielformate.
5. „Weitere Dateien hinzufügen“ ergänzt die Liste, ohne bestehende Dateien und Auswahlen zu verwerfen.
6. Erst „Konvertieren“ startet die Verarbeitung. Danach erscheinen Status, Fehler beziehungsweise Download an der jeweiligen Datei.

Die zusätzliche Frage „Was soll passieren?“ soll für die Konvertierung entfallen. Die Datei bleibt während Auswahl, Verarbeitung und Ergebnis sichtbar. Nutzer müssen dieselbe Datei nicht erneut auswählen.

## Bestehender Stand

- `src/components/home/QuickStart.tsx` verwendet aktuell die Schritte `select`, `choose` und `tool`. Nach der Erkennung folgen Aktionsbuttons; das Zielformat wird erst im Werkzeug ausgewählt.
- `src/lib/quickstart.ts` übernimmt die lokale Klassifizierung und Zuordnung passender Werkzeuge.
- Vorhandene Werkzeugkomponenten übernehmen Dateien über `initialFiles` und enthalten bereits Validierung und Verarbeitung.
- Diese Spezifikation präzisiert den Ablauf aus `2026-11-13-minimal-dropzone-design.md`: Konvertierungsoptionen sollen unmittelbar bei den gewählten Dateien stehen.

## Welche Optionen angeboten werden

- **Bilder:** Nur tatsächlich verfügbare Ausgabeformate aus der bestehenden Formatauswahl und den ermittelten Browserfähigkeiten anzeigen. Bestehende Eingabeprüfung und Grenzen beibehalten.
- **Audio:** MP3, WAV, FLAC und OGG gemäß bestehendem Formatkatalog. Keine zusätzlichen Formate aus dem Referenzbild übernehmen, beispielsweise AAC, AIFF oder ALAC.
- **PDF:** Aktuell ist Komprimierung vorhanden. Deshalb „PDF komprimieren“ anbieten und keine PDF-Konvertierung vortäuschen.
- **Unbekannte oder nicht unterstützte Dateien:** In der Liste sichtbar halten, verständlichen Grund anzeigen und keine ausführbare Konvertierung anbieten.
- **Gemischte Dateien:** Jede Datei erhält nur zu ihrem Typ passende Optionen. Keine globale Formatauswahl, die für einen Teil der Liste ungültig wäre.

Komprimieren und Skalieren bleiben für passende Dateien erreichbar, dürfen den direkten Konvertierungsablauf aber nicht wieder durch eine vorgeschaltete Aktionsseite ersetzen.

## Gestaltung und Bedienung

Die bestehende Muhr-Industries-Gestaltung bleibt Grundlage. Die Referenz gibt den Ablauf vor, nicht Farben, Branding, Werbung, Login oder Dateigrenzen.

- Desktop: Dateiinformationen links, Ausgabeauswahl und Entfernen rechts; darunter die primäre Startaktion.
- Mobil: dieselben Elemente untereinander, ohne horizontales Scrollen.
- Lange Dateinamen umbrechen und das Layout nicht verbreitern lassen.
- Zielformate zunächst über eine einfache, beschriftete Auswahl anbieten. Suche und Kategorien sind für die derzeitige Formatanzahl nicht erforderlich.
- Dateiauswahl, Entfernen, Formatwahl und Start müssen per Tastatur bedienbar sein. Erkennung und Verarbeitungsstatus werden zugänglich angekündigt.
- Während der Erkennung die Datei bereits mit einem Prüfstatus anzeigen; Konvertieren erst nach erfolgreicher Prüfung und gültiger Zielauswahl freigeben.
- Nach Entfernen der letzten Datei wieder die ursprüngliche Dropzone anzeigen.

## Empfohlener technischer Ansatz

Die Startseite erhält eine durchgehende Dateiliste mit stabilen Einträgen und einer Zielauswahl pro konvertierbarer Datei. Klassifizierung, Formatkataloge, Prüfungen und vorhandene Verarbeitung werden wiederverwendet. Die bestehende Stapelverarbeitung muss unterschiedliche Zielauswahlen korrekt berücksichtigen; die gewählte Ausgabe darf bei der Übergabe an das Werkzeug nicht verloren gehen oder durch dessen Standardwert ersetzt werden.

Eine reine automatische Weiterleitung in das bisherige Werkzeug wäre kleiner, erfüllt aber die unmittelbare Auswahl an jeder Datei und gemischte Listen nicht vollständig. Ein unabhängiger zweiter Konvertierungsweg würde Validierung und Verarbeitung duplizieren. Deshalb ist die Integration in den bestehenden Ablauf die Empfehlung; diese technische Entscheidung ist noch keine bestätigte Implementierungsfreigabe.

Dateien bleiben im Arbeitsspeicher. Keine Übergabe über localStorage, sessionStorage, IndexedDB oder Cache. Kein automatischer Upload beim Ablegen oder bei der Formatwahl. Die bestehenden servergestützten Bild- und Audioabläufe bleiben erhalten; die lokale Signaturprüfung erfolgt weiterhin vor dem Upload. Bestehende Datei- und Stapelgrenzen gelten weiterhin; die „1 GB“ aus dem Screenshot werden nicht übernommen.

## Abnahmekriterien

- Eine unterstützte Datei lässt sich ablegen und alternativ über den Dateidialog auswählen. In beiden Fällen erscheint dieselbe Dateizeile mit Name, Größe, erkanntem Format und passender Ausgabeauswahl.
- Eine WAV-Datei bietet die unterstützten Audioziele an. MP3 auswählen und starten verarbeitet genau diese Datei mit MP3 als Ziel.
- Bei Bildern enthält die Auswahl ausschließlich tatsächlich verfügbare Ausgabeformate.
- Weitere Dateien ergänzen die Liste; bisherige Zielauswahlen bleiben erhalten. Entfernen betrifft ausschließlich den gewählten Eintrag.
- Unterschiedliche Zielformate innerhalb einer Liste werden bei der Verarbeitung korrekt übernommen.
- PDF, unbekannte Typen, ungültige Dateien und überschrittene Grenzen erhalten verständliche, dateibezogene Rückmeldungen. Gültige andere Einträge bleiben bedienbar.
- Vor dem ausdrücklichen Start findet kein Datei-Upload und keine Konvertierung statt.
- Nach dem Start bleiben Dateien, Fortschritt, Fehler und Downloads eindeutig zugeordnet. Ein Fehler bei einer Datei versteckt keine anderen Ergebnisse.
- Bedienung funktioniert mit Tastatur sowie bei 390 px und 1440 px Breite im hellen und dunklen Design.
- Für die spätere Umsetzung: passende Komponenten- und Playwright-Tests ergänzen beziehungsweise anpassen; `npm run check`, `npm test` und `npm run build` ausführen.

## Umfang dieses Dokuments

Diese Änderung dokumentiert den gewünschten Fix. Produktcode, Backend und Rate-Limiting werden damit noch nicht geändert.
