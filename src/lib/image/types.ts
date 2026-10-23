/**
 * Gemeinsamer Schnittstellenvertrag des Bildverarbeitungskerns.
 *
 * Diese Datei wird von Kern (src/lib/image/*) und Oberfläche (src/components/*)
 * gemeinsam genutzt. Änderungen nur abgestimmt vornehmen.
 */

/** Unterstützte Ein- und Ausgabeformate. */
export type ImageFormat = 'jpeg' | 'png' | 'webp';

export const IMAGE_FORMATS: readonly ImageFormat[] = ['jpeg', 'png', 'webp'];

export interface FormatInfo {
  /** MIME-Typ, den der Encoder liefern muss. */
  readonly mime: string;
  /** Dateiendung ohne Punkt. */
  readonly extension: string;
  /** Anzeigename. */
  readonly label: string;
  /**
   * Ob ein Qualitätsparameter beim Kodieren im Browser tatsächlich wirkt.
   * Bei PNG ignorieren Browser den Qualitätswert, daher false.
   */
  readonly supportsQuality: boolean;
  /** Ob das Format einen Alphakanal speichern kann. */
  readonly supportsTransparency: boolean;
}

export const FORMAT_INFO: Readonly<Record<ImageFormat, FormatInfo>> = {
  jpeg: { mime: 'image/jpeg', extension: 'jpg', label: 'JPEG', supportsQuality: true, supportsTransparency: false },
  png: { mime: 'image/png', extension: 'png', label: 'PNG', supportsQuality: false, supportsTransparency: true },
  webp: { mime: 'image/webp', extension: 'webp', label: 'WebP', supportsQuality: true, supportsTransparency: true },
};

/** Ergebnis der Kodierungs-Fähigkeitsprüfung: welche Ausgabeformate der Browser wirklich erzeugt. */
export type EncodeSupport = Readonly<Record<ImageFormat, boolean>>;

export interface Dimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * Größenänderung.
 *
 * Allgemeine Regeln für computeTargetSize(source, resize):
 * - source sind die orientierungskorrigierten Abmessungen (so wie das Bild angezeigt wird).
 * - Ergebnis wird mit Math.round gerundet, Mindestwert 1 px je Kante.
 * - Alle Pixelangaben (width, height, maxEdge) müssen positive Ganzzahlen sein,
 *   percent eine endliche Zahl > 0; sonst ImageProcessingError('invalid-options').
 * - upscaled = Zielbreite > Quellbreite ODER Zielhöhe > Quellhöhe.
 * - Ziel über den Grenzwerten (limits.ts) -> ImageProcessingError('dimensions-too-large').
 */
export type ResizeOptions =
  | { readonly mode: 'none' }
  | {
      readonly mode: 'percent';
      /**
       * Prozent der Originalgröße (> 0), angewendet auf beide Kanten.
       * Werte > 100 mit allowUpscale = false -> 'invalid-options'
       * (die Oberfläche verhindert diese Kombination vorab).
       */
      readonly percent: number;
      readonly allowUpscale: boolean;
    }
  | {
      readonly mode: 'dimensions';
      /** Zielbreite in Pixeln; undefined = aus Höhe und Seitenverhältnis ableiten. */
      readonly width?: number;
      /** Zielhöhe in Pixeln; undefined = aus Breite und Seitenverhältnis ableiten. */
      readonly height?: number;
      /**
       * true: proportional. Mit nur einer Angabe wird die andere Kante abgeleitet; mit beiden
       *   wird das Bild so skaliert, dass es in width × height passt (contain). Mindestens eine
       *   Angabe ist nötig, sonst 'invalid-options'.
       * false: exakt width × height (Verzerrung möglich); beide Angaben nötig, sonst 'invalid-options'.
       */
      readonly keepAspectRatio: boolean;
      /**
       * false: Ziel größer als die Quelle wird auf die Quellgröße begrenzt.
       *   Bei keepAspectRatio = true unter Erhalt des Seitenverhältnisses (Faktor auf ≤ 1 begrenzt),
       *   bei keepAspectRatio = false jede Kante einzeln auf die Quellkante begrenzt.
       * true: Vergrößerung erlaubt.
       */
      readonly allowUpscale: boolean;
    }
  | {
      readonly mode: 'maxEdge';
      /** Längste Kante höchstens so viele Pixel (proportional); kleinere Bilder bleiben unverändert. */
      readonly maxEdge: number;
    };

export interface ProcessOptions {
  /** Zielformat. Wird nie still ersetzt: liefert der Browser es nicht, -> 'encode-unsupported'. */
  readonly format: ImageFormat;
  /**
   * Qualität 0..1 (außerhalb -> 'invalid-options').
   * Wird nur verwendet, wenn FORMAT_INFO[format].supportsQuality, sonst ignoriert.
   */
  readonly quality: number;
  /**
   * Hintergrundfarbe als #rrggbb (sonst 'invalid-options'), mit der transparente Bereiche
   * gefüllt werden, wenn das Zielformat keine Transparenz unterstützt (JPEG).
   */
  readonly background: string;
  readonly resize: ResizeOptions;
}

/** Ergebnis der Vorabprüfung einer Datei anhand ihrer Bytes (nicht der Endung oder file.type). */
export interface ProbeResult {
  readonly format: ImageFormat;
  /**
   * Abmessungen aus dem Dateiheader, nach Anwendung einer erkannten EXIF-Orientierung.
   * Dienen der Anzeige und der Grenzprüfung vor dem Dekodieren. Maßgeblich für die
   * Verarbeitung sind die Abmessungen der dekodierten Bitmap.
   */
  readonly width: number;
  readonly height: number;
  /** Erkannte EXIF-Orientierung 1..8 (1 = keine Drehung oder nicht vorhanden). */
  readonly orientation: number;
  /** Ob die Datei einen Alphakanal haben kann (PNG mit Alpha/tRNS, WebP mit Alpha). Heuristisch. */
  readonly mayHaveTransparency: boolean;
}

export interface ProcessResult {
  readonly blob: Blob;
  readonly format: ImageFormat;
  /** Tatsächlicher, geprüfter MIME-Typ des Ergebnisses (stimmt mit FORMAT_INFO[format].mime überein). */
  readonly mime: string;
  /** Abmessungen der dekodierten, orientierungskorrigierten Quelle. */
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly width: number;
  readonly height: number;
  /** Ob das Ergebnis in Breite oder Höhe größer als die Quelle ist. */
  readonly upscaled: boolean;
  /** Ob transparente Bereiche mit der Hintergrundfarbe gefüllt wurden (Zielformat ohne Alpha). */
  readonly transparencyFlattened: boolean;
}

export type ImageErrorCode =
  | 'unsupported-type' // keine JPEG/PNG/WebP-Signatur
  | 'file-too-large' // Dateigröße über Limit
  | 'dimensions-too-large' // Eingabe- oder Zielabmessungen über Limit, oder Canvas dieser Größe nicht nutzbar
  | 'animated-unsupported' // animiertes PNG/WebP
  | 'decode-failed' // beschädigt oder vom Browser nicht dekodierbar
  | 'invalid-options' // ungültige Einstellungen (z. B. Breite 0)
  | 'encode-unsupported' // Browser liefert das Zielformat nicht (falscher MIME-Typ)
  | 'encode-failed' // Kodierung fehlgeschlagen oder leeres Ergebnis
  | 'aborted'; // vom Nutzer abgebrochen/entfernt, oder Prozessor beendet

/**
 * Fehler des Kerns. `message` ist ein technischer Text für Entwickler; die Oberfläche
 * zeigt Nutzern eigene deutsche Texte anhand von `code` an.
 * Über die Worker-Grenze wird { code, message } serialisiert und im Hauptthread
 * wieder als ImageProcessingError erzeugt.
 */
export class ImageProcessingError extends Error {
  readonly code: ImageErrorCode;

  constructor(code: ImageErrorCode, message: string) {
    super(message);
    this.name = 'ImageProcessingError';
    this.code = code;
  }
}

export interface ProcessCallOptions {
  /** Abbruch: wartende Aufträge werden verworfen, laufende abgebrochen bzw. ihr Ergebnis verworfen. */
  readonly signal?: AbortSignal;
  /** Wird aufgerufen, sobald der Auftrag die Warteschlange verlässt und tatsächlich startet. */
  readonly onStart?: () => void;
}

/**
 * Öffentliche Kern-API (implementiert in src/lib/image/index.ts):
 *
 *   probeImage(file: Blob): Promise<ProbeResult>
 *     Prüft Größenlimit, Signatur, Animation und Header-Abmessungen anhand der Bytes.
 *     Wirft ImageProcessingError.
 *
 *   computeTargetSize(source: Dimensions, resize: ResizeOptions):
 *     { width: number; height: number; upscaled: boolean }
 *     Reine Funktion, Regeln siehe ResizeOptions.
 *
 *   buildOutputFileName(originalName: string, format: ImageFormat, suffix: string): string
 *     Entfernt die bisherige Endung, ersetzt Pfadtrenner und Steuerzeichen, kürzt überlange
 *     Namen, fällt bei leerem Namen auf "bild" zurück und hängt -suffix und die Endung des
 *     Zielformats an, z. B. ("Urlaub.PNG", 'webp', 'konvertiert') -> "Urlaub-konvertiert.webp".
 *
 *   createImageProcessor(): ImageProcessor
 *
 *   LIMITS (limits.ts): Grenzwerte zur Anzeige in der Oberfläche.
 */
export interface ImageProcessor {
  /** Kodierungsfähigkeiten des Kontexts, in dem verarbeitet wird (Worker oder Hauptthread). Gecacht. */
  getEncodeSupport(): Promise<EncodeSupport>;
  /**
   * Verarbeitet eine Datei: führt selbst probeImage aus, dekodiert (Orientierung aus der Datei),
   * berechnet die Zielgröße, kodiert und prüft den MIME-Typ des Ergebnisses.
   * Läuft mit begrenzter Parallelität (Warteschlange intern).
   */
  process(file: Blob, options: ProcessOptions, call?: ProcessCallOptions): Promise<ProcessResult>;
  /** Beendet Worker; alle offenen Promises werden mit 'aborted' abgelehnt. */
  dispose(): void;
}
