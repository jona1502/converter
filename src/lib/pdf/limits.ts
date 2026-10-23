/**
 * Grenzwerte des PDF-Kerns. Dezimale Einheiten (1 MB = 1.000.000 Bytes), damit die Anzeige über
 * formatBytes() exakt „100 MB“ bzw. „300 MB“ ergibt.
 */
export const PDF_LIMITS = {
  /**
   * Maximale Eingabegröße: 100 MB. pdf-lib hält die Datei plus Objektbaum im Speicher, der
   * Worker zusätzlich das gespeicherte Ergebnis; bei 100 MB liegt die Spitze je Variante
   * erfahrungsgemäß bei einigen hundert MB – mehr ist in mobilen Tabs nicht verlässlich.
   */
  maxFileBytes: 100_000_000,
  /**
   * Maximale Pixelzahl je Bild (40 MP, wie im Bildwerkzeug). Eine RGBA-Bitmap dieser Größe belegt
   * 160 MB; Rohdaten + ImageData + Canvas kommen auf rund das Dreifache. Größere Bilder bleiben
   * unverändert (Grund 'too-many-pixels').
   */
  maxImagePixels: 40_000_000,
  /**
   * Gesamtbudget der in einem compressAll-Aufruf gelieferten Ergebnisse: 300 MB
   * (= drei Varianten einer maximal großen Eingabe ohne Einsparung). Eine Variante, die das
   * Budget überschreiten würde, wird verworfen und als 'memory-limit' gemeldet; die übrigen
   * bleiben erhalten.
   */
  maxResultBytesTotal: 300_000_000,
  /**
   * Obergrenze der dekodierten Content-Stream-Bytes für die Ermittlung der Darstellungsgröße
   * von Bildern. Darüber gilt die Darstellungsgröße als unbekannt (nur Kantenbegrenzung).
   */
  maxContentBytesForPlacement: 200_000_000,
  /** Verschachtelungstiefe von Form-XObjects bei der Auswertung der Content-Streams. */
  maxFormDepth: 16,
  /** Bereich am Dateianfang, in dem die Signatur %PDF- stehen muss (wie bei gängigen Readern). */
  signatureSearchBytes: 1024,
} as const;
