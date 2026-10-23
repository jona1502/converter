import { createCanvas, getContext2D, releaseCanvas } from './canvas';
import { decodeSample } from './decode-samples';
import { encodeImage } from './encode';
import {
  INPUT_FORMATS,
  OUTPUT_FORMATS,
  type DecodeSupport,
  type EncodeSupport,
  type InputFormat,
  type OutputFormat,
} from './types';

let encodeCache: Promise<EncodeSupport> | null = null;
let decodeCache: Promise<DecodeSupport> | null = null;

async function canEncode(format: OutputFormat, source: ImageBitmap): Promise<boolean> {
  try {
    // Echter Durchlauf durch denselben Encoder samt Ergebnisprüfung (MIME-Typ und Signatur).
    await encodeImage({
      source,
      width: 1,
      height: 1,
      format,
      quality: 0.9,
      background: '#ffffff',
      sourceMayHaveTransparency: false,
      icoSizes: [16],
    });
    return true;
  } catch {
    return false;
  }
}

async function makeSourceBitmap(): Promise<ImageBitmap | null> {
  if (typeof createImageBitmap !== 'function') return null;
  const canvas = createCanvas(1, 1);
  if (!canvas) return null;
  try {
    const ctx = getContext2D(canvas);
    if (!ctx) return null;
    ctx.fillStyle = '#336699';
    ctx.fillRect(0, 0, 1, 1);
    return await createImageBitmap(canvas);
  } catch {
    return null;
  } finally {
    releaseCanvas(canvas);
  }
}

/**
 * Prüft im aktuellen Kontext (Worker oder Fenster), welche Ausgabeformate wirklich erzeugt werden:
 * je Format wird ein 1×1-Bild mit demselben Encoder wie bei der Verarbeitung kodiert und geprüft.
 * Gecacht. Für die Oberfläche: ImageProcessor.getEncodeSupport() verwenden.
 */
export function detectEncodeSupport(): Promise<EncodeSupport> {
  encodeCache ??= (async () => {
    const source = await makeSourceBitmap();
    const result = {} as Record<OutputFormat, boolean>;
    for (const format of OUTPUT_FORMATS) result[format] = source ? await canEncode(format, source) : false;
    source?.close();
    return Object.freeze(result);
  })();
  return encodeCache;
}

async function canDecode(format: InputFormat): Promise<boolean> {
  try {
    const sample = decodeSample(format);
    const bitmap = await createImageBitmap(new Blob([sample as Uint8Array<ArrayBuffer>]));
    const ok = bitmap.width === 1 && bitmap.height === 1;
    bitmap.close();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Prüft im aktuellen Kontext per echtem Dekodierversuch je Eingabeformat (1×1-Beispieldatei),
 * welche Formate createImageBitmap dekodiert. Gecacht.
 * Für die Oberfläche: ImageProcessor.getDecodeSupport() verwenden.
 */
export function detectDecodeSupport(): Promise<DecodeSupport> {
  decodeCache ??= (async () => {
    const result = {} as Record<InputFormat, boolean>;
    const available = typeof createImageBitmap === 'function';
    for (const format of INPUT_FORMATS) result[format] = available ? await canDecode(format) : false;
    return Object.freeze(result);
  })();
  return decodeCache;
}
