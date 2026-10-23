/**
 * Schnittstellenvertrag des PDF-Komprimierungskerns (src/lib/pdf/*).
 *
 * Wird vom Kern und von der Oberfläche (P11) gemeinsam genutzt. Alle Größen sind echte,
 * gemessene Bytezahlen; der Kern schätzt nichts und verspricht keine Einsparung.
 */

/** Qualitätsstufen in der Reihenfolge, in der sie standardmäßig berechnet werden. */
export type PdfQualityLevel = 'high' | 'balanced' | 'small';

export const PDF_QUALITY_LEVELS: readonly PdfQualityLevel[] = ['high', 'balanced', 'small'];

/**
 * Einstellungen einer Stufe. Konkrete Werte und ihre Begründung: presets.ts.
 *
 * Zielauflösung eines Bildes:
 * - Ist die Darstellungsgröße auf allen Seiten ermittelbar (Content-Streams ausgewertet),
 *   wird auf targetDpi bezogen auf die größte Darstellung verkleinert.
 * - Zusätzlich (und als einzige Regel, wenn die Darstellungsgröße unbekannt ist) wird die
 *   längste Kante auf maxImageEdge begrenzt.
 * - Es wird nie vergrößert. Ergibt sich ein Faktor über minDownscaleFactor, bleibt die
 *   Pixelgröße unverändert (Neuabtastung kostet Schärfe und spart dann kaum).
 */
export interface PdfQualityPreset {
  readonly level: PdfQualityLevel;
  readonly targetDpi: number;
  readonly maxImageEdge: number;
  /** JPEG-Qualität 0..1 für OffscreenCanvas.convertToBlob. */
  readonly jpegQuality: number;
  readonly minDownscaleFactor: number;
}

/**
 * Gründe, aus denen ein Bild unverändert bleibt (ein Grund je Bild, in dieser Prüfreihenfolge).
 */
export type PdfImageSkipReason =
  | 'invalid-dict' // Breite/Höhe fehlen oder sind ungültig
  | 'image-mask' // /ImageMask true (1-bit-Schablone)
  | 'filter' // JPX, JBIG2, CCITT, LZW, RunLength, ASCII-Filter oder Filterketten
  | 'decode-parms' // DCT mit DecodeParms bzw. Flate mit nicht unterstütztem Predictor
  | 'colorspace' // Indexed, ICCBased, Lab, Cal*, Separation, DeviceN, fehlend
  | 'cmyk' // DeviceCMYK bzw. ICCBased mit 4 Kanälen: Farbwiedergabe nicht sicher erhaltbar
  | 'bits-per-component' // nicht 8 bit
  | 'decode-array' // /Decode abweichend vom Standard (z. B. invertierte Adobe-CMYK-JPEGs)
  | 'mask' // /Mask oder /SMask – Transparenzdaten bleiben konservativ unverändert
  | 'too-many-pixels' // über PDF_LIMITS.maxImagePixels
  | 'decode-failed'; // Bilddaten vom Browser nicht dekodierbar oder Größe passt nicht zum Dict

export type PdfImageFilterKind = 'dct' | 'flate' | 'none' | 'other';

export interface PdfImageSummary {
  /** Bild-XObjects ohne solche, die nur als Soft-Mask/Maske anderer Bilder dienen. */
  readonly total: number;
  /** Davon grundsätzlich neu kodierbar (ob es kleiner wird, zeigt erst die Komprimierung). */
  readonly recompressible: number;
  /** Davon unverändert, nach Grund (nur Gründe mit Anzahl > 0). */
  readonly skipped: Readonly<Partial<Record<PdfImageSkipReason, number>>>;
  /** Anzahl nach Filter. */
  readonly byFilter: Readonly<Record<PdfImageFilterKind, number>>;
  /** Gespeicherte Bytes aller Bilder (Stream-Längen, inkl. Soft-Masks). */
  readonly bytes: number;
  /** Davon in neu kodierbaren Bildern. */
  readonly recompressibleBytes: number;
  /** Anzahl Soft-Masks/Masken (separat, nicht in total enthalten). */
  readonly maskCount: number;
}

/**
 * Konkrete Grenzen, die der Kern meldet. Die Oberfläche formuliert daraus Hinweise.
 */
export type PdfLimitationCode =
  | 'no-images' // keine Rasterbilder: nur verlustfreie Optimierung möglich
  | 'images-not-recompressible' // count: Bilder, die unverändert bleiben (Gründe: images.skipped)
  | 'embedded-fonts-unchanged' // bytes: eingebettete Schriften werden nicht verkleinert (kein Subsetting)
  | 'signatures-invalidated' // count: digitale Signaturen werden durch das Neuschreiben ungültig
  | 'image-size-unknown'; // count: Darstellungsgröße unbekannt, nur Pixel-Kantenbegrenzung

export interface PdfLimitation {
  readonly code: PdfLimitationCode;
  readonly count?: number;
  readonly bytes?: number;
}

export interface PdfAnalysis {
  readonly fileSize: number;
  readonly pdfVersion: string;
  readonly pageCount: number;
  /** Immer false: verschlüsselte Dateien werden mit 'encrypted' abgelehnt. */
  readonly encrypted: false;
  readonly images: PdfImageSummary;
  /** Bytes eingebetteter Schriftprogramme (FontFile, FontFile2, FontFile3). */
  readonly fontBytes: number;
  readonly limitations: readonly PdfLimitation[];
}

export type PdfVariantPhase = 'queued' | 'loading' | 'images' | 'saving' | 'done' | 'error';

/**
 * Statusereignis einer Variante. current/total gibt es nur in 'images':
 * current = Anzahl bereits bearbeiteter Bilder (0..total), total = Bilder im Dokument.
 */
export interface PdfVariantStatus {
  readonly level: PdfQualityLevel;
  readonly phase: PdfVariantPhase;
  readonly current?: number;
  readonly total?: number;
  /** Nur bei phase 'error'. */
  readonly errorCode?: PdfErrorCode;
}

export type PdfResultNoteCode =
  | 'images-not-smaller' // count: neu kodiert, aber nicht kleiner – Original behalten
  | 'images-skipped' // count: nicht neu kodierbar (siehe Analyse)
  | 'image-size-unknown' // count: nur Pixel-Kantenbegrenzung angewendet
  | 'signatures-invalidated'
  | 'pdf-version-raised'; // Kopfzeile auf 1.7 angehoben (für Objekt-Streams nötig)

export interface PdfResultNote {
  readonly code: PdfResultNoteCode;
  readonly count?: number;
}

export interface PdfVariantResult {
  readonly level: PdfQualityLevel;
  readonly blob: Blob;
  /** Tatsächliche Größe (blob.size). Kann größer als die Eingabe sein. */
  readonly size: number;
  readonly originalSize: number;
  readonly imagesRecompressed: number;
  /** Davon in der Pixelgröße verkleinert. */
  readonly imagesResized: number;
  readonly imagesSkipped: number;
  readonly imagesNotSmaller: number;
  /** Zuvor unkomprimierte Streams, die verlustfrei Flate-komprimiert wurden. */
  readonly streamsCompressed: number;
  /** Entfernte, nirgends referenzierte Objekte. */
  readonly objectsRemoved: number;
  readonly notes: readonly PdfResultNote[];
}

export type PdfErrorCode =
  | 'not-pdf' // keine %PDF--Signatur in den ersten 1024 Bytes
  | 'encrypted' // verschlüsselt (auch mit leerem Benutzerpasswort)
  | 'file-too-large' // über PDF_LIMITS.maxFileBytes
  | 'parse-failed' // beschädigt oder nicht lesbar
  | 'memory-limit' // Speicherbudget für Ergebnisse überschritten
  | 'save-failed' // Schreiben des Ergebnisses fehlgeschlagen
  | 'unsupported-browser' // OffscreenCanvas/createImageBitmap/(De)CompressionStream im Worker fehlen
  | 'invalid-options' // unbekannte Stufe o. Ä.
  | 'worker-failed' // Worker abgestürzt (z. B. Speichermangel des Tabs)
  | 'aborted';

/**
 * Fehler des PDF-Kerns. `message` ist technisch; Nutzertexte erzeugt die Oberfläche anhand von `code`.
 */
export class PdfProcessingError extends Error {
  readonly code: PdfErrorCode;

  constructor(code: PdfErrorCode, message: string) {
    super(message);
    this.name = 'PdfProcessingError';
    this.code = code;
  }
}

/** Fehler, die alle Varianten betreffen: compressAll bricht dann insgesamt ab. */
export const GLOBAL_PDF_ERROR_CODES: readonly PdfErrorCode[] = [
  'not-pdf',
  'encrypted',
  'file-too-large',
  'parse-failed',
  'unsupported-browser',
  'invalid-options',
  'worker-failed',
  'aborted',
];

export type PdfVariantOutcome =
  | { readonly level: PdfQualityLevel; readonly ok: true; readonly result: PdfVariantResult }
  | { readonly level: PdfQualityLevel; readonly ok: false; readonly error: PdfProcessingError };

export interface PdfCompressOptions {
  /** Statusereignisse in zeitlicher Reihenfolge; Varianten laufen strikt nacheinander. */
  readonly onStatus?: (status: PdfVariantStatus) => void;
  /** Wird sofort aufgerufen, sobald eine Variante fertig ist. */
  readonly onResult?: (result: PdfVariantResult) => void;
  /** Abbruch beendet den Worker; bereits gelieferte Ergebnisse bleiben gültig. */
  readonly signal?: AbortSignal;
}

/**
 * Öffentliche API (src/lib/pdf/index.ts): createPdfCompressor().
 * Es läuft immer höchstens ein Auftrag gleichzeitig; weitere Aufrufe warten.
 */
export interface PdfCompressor {
  /** Prüft Größe, Signatur, Verschlüsselung und analysiert die Bilder. Wirft PdfProcessingError. */
  analyze(file: Blob, signal?: AbortSignal): Promise<PdfAnalysis>;
  /**
   * Erzeugt die Varianten nacheinander. Löst mit je einem Ergebnis pro Stufe auf (Erfolg oder
   * variantenbezogener Fehler wie 'memory-limit'/'save-failed'). Globale Fehler
   * (GLOBAL_PDF_ERROR_CODES) lehnen das Promise ab.
   */
  compressAll(
    file: Blob,
    levels: readonly PdfQualityLevel[],
    options?: PdfCompressOptions,
  ): Promise<PdfVariantOutcome[]>;
  /** Beendet den Worker; offene Promises werden mit 'aborted' abgelehnt. */
  dispose(): void;
}
