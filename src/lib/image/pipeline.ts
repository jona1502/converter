import { encodeImage } from './encode';
import { isWithinPixelLimits } from './limits';
import { abortedError } from './errors';
import { probeImage } from './probe';
import { computeTargetSize } from './resize';
import { IMAGE_FORMATS, ImageProcessingError, type ProcessOptions, type ProcessResult } from './types';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function invalid(message: string): ImageProcessingError {
  return new ImageProcessingError('invalid-options', message);
}

/** Prüft ProcessOptions (Format, Qualität 0..1, Hintergrund #rrggbb, Größenänderung vorhanden). */
export function validateProcessOptions(options: ProcessOptions): void {
  if (options === null || typeof options !== 'object') throw invalid('Optionen fehlen.');
  if (!IMAGE_FORMATS.includes(options.format)) throw invalid('Unbekanntes Zielformat.');
  const { quality } = options;
  if (typeof quality !== 'number' || !Number.isFinite(quality) || quality < 0 || quality > 1) {
    throw invalid('Qualität muss zwischen 0 und 1 liegen.');
  }
  if (typeof options.background !== 'string' || !HEX_COLOR.test(options.background)) {
    throw invalid('Hintergrundfarbe muss im Format #rrggbb angegeben werden.');
  }
  if (options.resize === null || typeof options.resize !== 'object') throw invalid('Größenänderung fehlt.');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortedError();
}

/** Dekodiert mit Orientierung aus der Datei. Browser ohne imageOrientation-Option erhalten einen zweiten Versuch ohne. */
async function decode(file: Blob): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== 'function') {
    throw new ImageProcessingError('decode-failed', 'createImageBitmap ist nicht verfügbar.');
  }
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (error) {
    if (error instanceof TypeError) {
      try {
        return await createImageBitmap(file);
      } catch (retryError) {
        throw new ImageProcessingError('decode-failed', `Dekodierung fehlgeschlagen: ${String(retryError)}`);
      }
    }
    throw new ImageProcessingError('decode-failed', `Dekodierung fehlgeschlagen: ${String(error)}`);
  }
}

/**
 * Vollständige Verarbeitung einer Datei: Optionen prüfen → probeImage → dekodieren →
 * Zielgröße → kodieren und Ergebnis prüfen. Läuft im Worker und im Hauptthread.
 */
export async function runPipeline(file: Blob, options: ProcessOptions, signal?: AbortSignal): Promise<ProcessResult> {
  validateProcessOptions(options);
  throwIfAborted(signal);
  const probe = await probeImage(file);
  // Frühe Prüfung der Einstellungen und Zielgrenzen, bevor teuer dekodiert wird.
  computeTargetSize(probe, options.resize);
  throwIfAborted(signal);

  const bitmap = await decode(file);
  try {
    throwIfAborted(signal);
    const sourceWidth = bitmap.width;
    const sourceHeight = bitmap.height;
    if (!(sourceWidth > 0 && sourceHeight > 0)) {
      throw new ImageProcessingError('decode-failed', 'Dekodiertes Bild hat keine Abmessungen.');
    }
    if (!isWithinPixelLimits(sourceWidth, sourceHeight)) {
      throw new ImageProcessingError('dimensions-too-large', `Dekodiertes Bild hat ${sourceWidth} × ${sourceHeight} px.`);
    }
    const unrotated =
      probe.orientation >= 5 &&
      probe.width !== probe.height &&
      sourceWidth === probe.height &&
      sourceHeight === probe.width;
    if (unrotated) {
      // Browser hat die EXIF-Orientierung nicht angewendet: lieber ablehnen als still falsch drehen.
      throw new ImageProcessingError('decode-failed', 'EXIF-Orientierung wurde beim Dekodieren nicht angewendet.');
    }
    const target = computeTargetSize({ width: sourceWidth, height: sourceHeight }, options.resize);
    const encoded = await encodeImage({
      source: bitmap,
      width: target.width,
      height: target.height,
      format: options.format,
      quality: options.quality,
      background: options.background,
      sourceMayHaveTransparency: probe.mayHaveTransparency,
    });
    throwIfAborted(signal);
    return {
      blob: encoded.blob,
      format: options.format,
      mime: encoded.mime,
      sourceWidth,
      sourceHeight,
      width: target.width,
      height: target.height,
      upscaled: target.upscaled,
      transparencyFlattened: encoded.transparencyFlattened,
    };
  } finally {
    bitmap.close();
  }
}
