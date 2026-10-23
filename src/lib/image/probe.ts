import { isWithinPixelLimits, LIMITS } from './limits';
import { sniffImage, type SniffResult } from './sniff';
import { ImageProcessingError, type ProbeResult } from './types';

/** Anzahl Bytes, die zunächst gelesen werden. Reicht für fast alle Header aus. */
const HEAD_BYTES = 128 * 1024;

async function readBytes(blob: Blob): Promise<Uint8Array> {
  try {
    return new Uint8Array(await blob.arrayBuffer());
  } catch (error) {
    throw new ImageProcessingError('decode-failed', `Datei konnte nicht gelesen werden: ${String(error)}`);
  }
}

/**
 * Vorabprüfung anhand der Bytes: Größenlimit (vor dem Lesen) → Signatur → Animation →
 * Header-Abmessungen → Pixel-/Kantenlimit. Wirft ImageProcessingError.
 */
export async function probeImage(file: Blob): Promise<ProbeResult> {
  if (file.size > LIMITS.maxFileBytes) {
    throw new ImageProcessingError('file-too-large', `Datei hat ${file.size} Bytes, erlaubt sind ${LIMITS.maxFileBytes}.`);
  }

  let sniff: SniffResult | null = sniffImage(await readBytes(file.slice(0, HEAD_BYTES)));
  if (sniff === null) {
    throw new ImageProcessingError('unsupported-type', 'Keine JPEG-, PNG- oder WebP-Signatur gefunden.');
  }
  if (!sniff.complete && file.size > HEAD_BYTES) {
    // Header reicht über den Anfang hinaus (z. B. große APP-Segmente vor SOF): ganze Datei auswerten.
    sniff = sniffImage(await readBytes(file)) ?? sniff;
  }

  if (sniff.animated) {
    throw new ImageProcessingError('animated-unsupported', `Animiertes ${sniff.format.toUpperCase()} wird nicht unterstützt.`);
  }
  if (sniff.width === null || sniff.height === null) {
    throw new ImageProcessingError('decode-failed', 'Abmessungen konnten aus dem Dateiheader nicht ermittelt werden.');
  }

  const swap = sniff.orientation >= 5 && sniff.orientation <= 8;
  const width = swap ? sniff.height : sniff.width;
  const height = swap ? sniff.width : sniff.height;

  if (!isWithinPixelLimits(width, height)) {
    throw new ImageProcessingError(
      'dimensions-too-large',
      `Bild hat ${width} × ${height} px, erlaubt sind höchstens ${LIMITS.maxPixels} px und ${LIMITS.maxEdge} px je Kante.`,
    );
  }

  return {
    format: sniff.format,
    width,
    height,
    orientation: sniff.orientation,
    mayHaveTransparency: sniff.mayHaveTransparency,
  };
}
