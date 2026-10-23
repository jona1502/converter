/**
 * Gemeinsamer Schnittstellenvertrag des Bildverarbeitungskerns.
 *
 * Diese Datei wird von Kern (src/lib/image/*) und Oberfläche (src/components/*)
 * gemeinsam genutzt. Änderungen nur abgestimmt vornehmen.
 */

/**
 * Eingabeformate, erkannt anhand der Dateibytes (nicht der Endung).
 * Ob der Browser ein Eingabeformat tatsächlich dekodiert, liefert ImageProcessor.getDecodeSupport().
 */
export type InputFormat = 'jpeg' | 'png' | 'webp' | 'gif' | 'bmp' | 'ico' | 'avif';

export const INPUT_FORMATS: readonly InputFormat[] = ['jpeg', 'png', 'webp', 'gif', 'bmp', 'ico', 'avif'];

/** Ausgabeformate. */
export type OutputFormat = 'jpeg' | 'png' | 'webp' | 'bmp' | 'ico';

export const OUTPUT_FORMATS: readonly OutputFormat[] = ['jpeg', 'png', 'webp', 'bmp', 'ico'];

/** Ausgabeformat (aus Kompatibilitätsgründen beibehaltener Name für OutputFormat). */
export type ImageFormat = OutputFormat;

/** Alle Ausgabeformate (aus Kompatibilitätsgründen beibehaltener Name für OUTPUT_FORMATS). */
export const IMAGE_FORMATS: readonly ImageFormat[] = OUTPUT_FORMATS;

/** Beschreibung eines Ausgabeformats. */
export interface FormatInfo {
  /** MIME-Typ, den der Encoder liefern muss. */
  readonly mime: string;
  /** Dateiendung ohne Punkt. */
  readonly extension: string;
  /** Anzeigename. */
  readonly label: string;
  /**
   * Ob ein Qualitätsparameter beim Kodieren tatsächlich wirkt.
   * Bei PNG ignorieren Browser den Qualitätswert, BMP und ICO sind verlustfrei, daher false.
   */
  readonly supportsQuality: boolean;
  /** Ob das Format einen Alphakanal speichert (sonst Füllung mit ProcessOptions.background). */
  readonly supportsTransparency: boolean;
  /**
   * 'canvas': kodiert der Browser (Canvas toBlob/convertToBlob).
   * 'custom': eigener Encoder des Kerns (BMP; ICO mit vom Browser kodierten PNG-Einträgen).
   */
  readonly encoder: 'canvas' | 'custom';
  /**
   * Ob ProcessOptions.resize gilt. Bei ICO legen stattdessen icoSizes die Größen fest;
   * resize muss dort { mode: 'none' } sein, sonst 'invalid-options'.
   */
  readonly supportsResize: boolean;
}

export const FORMAT_INFO: Readonly<Record<OutputFormat, FormatInfo>> = {
  jpeg: { mime: 'image/jpeg', extension: 'jpg', label: 'JPEG', supportsQuality: true, supportsTransparency: false, encoder: 'canvas', supportsResize: true },
  png: { mime: 'image/png', extension: 'png', label: 'PNG', supportsQuality: false, supportsTransparency: true, encoder: 'canvas', supportsResize: true },
  webp: { mime: 'image/webp', extension: 'webp', label: 'WebP', supportsQuality: true, supportsTransparency: true, encoder: 'canvas', supportsResize: true },
  bmp: { mime: 'image/bmp', extension: 'bmp', label: 'BMP', supportsQuality: false, supportsTransparency: false, encoder: 'custom', supportsResize: true },
  ico: { mime: 'image/x-icon', extension: 'ico', label: 'ICO (Symbol)', supportsQuality: false, supportsTransparency: true, encoder: 'custom', supportsResize: false },
};

/** Beschreibung eines Eingabeformats, z. B. für das accept-Attribut der Dateiauswahl. */
export interface InputFormatInfo {
  /** Gängige MIME-Typen (der erste ist der übliche). */
  readonly mimes: readonly string[];
  /** Gängige Dateiendungen ohne Punkt. */
  readonly extensions: readonly string[];
  readonly label: string;
}

export const INPUT_FORMAT_INFO: Readonly<Record<InputFormat, InputFormatInfo>> = {
  jpeg: { mimes: ['image/jpeg'], extensions: ['jpg', 'jpeg', 'jfif'], label: 'JPEG' },
  png: { mimes: ['image/png'], extensions: ['png'], label: 'PNG' },
  webp: { mimes: ['image/webp'], extensions: ['webp'], label: 'WebP' },
  gif: { mimes: ['image/gif'], extensions: ['gif'], label: 'GIF (nur unbewegt)' },
  bmp: { mimes: ['image/bmp', 'image/x-ms-bmp'], extensions: ['bmp', 'dib'], label: 'BMP' },
  ico: { mimes: ['image/x-icon', 'image/vnd.microsoft.icon'], extensions: ['ico'], label: 'ICO' },
  avif: { mimes: ['image/avif'], extensions: ['avif'], label: 'AVIF (nur unbewegt)' },
};

/** Ergebnis der Kodierungs-Fähigkeitsprüfung: welche Ausgabeformate wirklich erzeugt werden können. */
export type EncodeSupport = Readonly<Record<OutputFormat, boolean>>;

/** Ergebnis der Dekodierungs-Fähigkeitsprüfung: welche Eingabeformate der Browser wirklich dekodiert. */
export type DecodeSupport = Readonly<Record<InputFormat, boolean>>;

/** Mögliche Kantenlängen eines ICO-Eintrags in Pixeln. */
export type IcoSize = 16 | 32 | 48 | 64 | 128 | 256;

export const ICO_SIZES: readonly IcoSize[] = [16, 32, 48, 64, 128, 256];

/** Standardgrößen für ICO, wenn ProcessOptions.icoSizes fehlt. */
export const DEFAULT_ICO_SIZES: readonly IcoSize[] = [16, 32, 48, 256];

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
  readonly format: OutputFormat;
  /**
   * Qualität 0..1 (außerhalb -> 'invalid-options').
   * Wird nur verwendet, wenn FORMAT_INFO[format].supportsQuality, sonst ignoriert.
   */
  readonly quality: number;
  /**
   * Hintergrundfarbe als #rrggbb (sonst 'invalid-options'), mit der transparente Bereiche
   * gefüllt werden, wenn das Zielformat keine Transparenz unterstützt (JPEG, BMP).
   * Bei ICO ungenutzt (Rand und Transparenz bleiben transparent), muss aber gültig sein.
   */
  readonly background: string;
  /** Größenänderung. Bei ICO nur { mode: 'none' } erlaubt (sonst 'invalid-options'), siehe icoSizes. */
  readonly resize: ResizeOptions;
  /**
   * Nur für format 'ico': enthaltene Größen (je Eintrag ein quadratisches PNG). Standard DEFAULT_ICO_SIZES.
   * Mindestens eine Größe, nur Werte aus ICO_SIZES, keine Duplikate – sonst 'invalid-options'.
   * Jede Größe: Bild mit erhaltenem Seitenverhältnis eingepasst (contain), zentriert, transparenter Rand.
   * Kleinere Quellen werden vergrößert (erlaubt); dann ist ProcessResult.upscaled true.
   * Bei anderen Formaten ignoriert.
   */
  readonly icoSizes?: readonly IcoSize[];
}

/** Ergebnis der Vorabprüfung einer Datei anhand ihrer Bytes (nicht der Endung oder file.type). */
export interface ProbeResult {
  /** Erkanntes Eingabeformat. Ob der Browser es dekodiert, sagt ImageProcessor.getDecodeSupport(). */
  readonly format: InputFormat;
  /**
   * Abmessungen aus dem Dateiheader, nach Anwendung einer erkannten EXIF-Orientierung.
   * Dienen der Anzeige und der Grenzprüfung vor dem Dekodieren. Maßgeblich für die
   * Verarbeitung sind die Abmessungen der dekodierten Bitmap.
   * ICO: größter Eintrag. AVIF: größte ispe-Angabe (ggf. nach Drehung per irot).
   */
  readonly width: number;
  readonly height: number;
  /** Erkannte EXIF-Orientierung 1..8 (1 = keine Drehung oder nicht vorhanden). */
  readonly orientation: number;
  /**
   * Ob die Datei einen Alphakanal haben kann (PNG mit Alpha/tRNS, WebP/AVIF mit Alpha, GIF mit
   * Transparenzindex, 32-bit-BMP, ICO immer). Heuristisch.
   */
  readonly mayHaveTransparency: boolean;
}

export interface ProcessResult {
  readonly blob: Blob;
  readonly format: OutputFormat;
  /** Tatsächlicher, geprüfter MIME-Typ des Ergebnisses (stimmt mit FORMAT_INFO[format].mime überein). */
  readonly mime: string;
  /** Abmessungen der dekodierten, orientierungskorrigierten Quelle. */
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  /** Abmessungen des Ergebnisses; bei ICO die des größten Eintrags (quadratisch). */
  readonly width: number;
  readonly height: number;
  /**
   * Ob das Ergebnis in Breite oder Höhe größer als die Quelle ist.
   * ICO: ob mindestens ein Eintrag die Quelle vergrößert darstellt.
   */
  readonly upscaled: boolean;
  /** Ob transparente Bereiche mit der Hintergrundfarbe gefüllt wurden (Zielformat ohne Alpha). */
  readonly transparencyFlattened: boolean;
}

export type ImageErrorCode =
  | 'unsupported-type' // keine Signatur eines Eingabeformats (INPUT_FORMATS)
  | 'file-too-large' // Dateigröße über Limit
  | 'dimensions-too-large' // Eingabe- oder Zielabmessungen über Limit, oder Canvas dieser Größe nicht nutzbar
  | 'animated-unsupported' // animiertes PNG/WebP/GIF, AVIF-Bildfolge
  | 'decode-unsupported' // Format erkannt, aber dieser Browser dekodiert es nicht (z. B. AVIF)
  | 'decode-failed' // beschädigt oder trotz unterstütztem Format nicht dekodierbar
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
 *   buildOutputFileName(originalName: string, format: OutputFormat, suffix: string): string
 *     Entfernt die bisherige Endung, ersetzt Pfadtrenner und Steuerzeichen, kürzt überlange
 *     Namen, fällt bei leerem Namen auf "bild" zurück und hängt -suffix und die Endung des
 *     Zielformats an, z. B. ("Urlaub.PNG", 'webp', 'konvertiert') -> "Urlaub-konvertiert.webp".
 *
 *   makeUniqueFileNames(names: string[]): string[]
 *     Eindeutige Namen im Stapel (ohne Groß-/Kleinschreibung), z. B. "a.webp", "a-2.webp".
 *
 *   createImageProcessor(): ImageProcessor
 *
 *   LIMITS (limits.ts): Grenzwerte zur Anzeige in der Oberfläche.
 */
export interface ImageProcessor {
  /** Kodierungsfähigkeiten des Kontexts, in dem verarbeitet wird (Worker oder Hauptthread). Gecacht. */
  getEncodeSupport(): Promise<EncodeSupport>;
  /**
   * Dekodierungsfähigkeiten des Kontexts, in dem verarbeitet wird, per echtem Dekodierversuch
   * kleiner eingebetteter Beispieldateien. Nicht dekodierbare Formate liefern bei process()
   * 'decode-unsupported'. Gecacht.
   */
  getDecodeSupport(): Promise<DecodeSupport>;
  /**
   * Verarbeitet eine Datei: führt selbst probeImage aus, dekodiert (Orientierung aus der Datei),
   * berechnet die Zielgröße, kodiert und prüft den MIME-Typ des Ergebnisses.
   * Läuft mit begrenzter Parallelität (Warteschlange intern).
   */
  process(file: Blob, options: ProcessOptions, call?: ProcessCallOptions): Promise<ProcessResult>;
  /** Beendet Worker; alle offenen Promises werden mit 'aborted' abgelehnt. */
  dispose(): void;
}
