import { canvasToBlob, createCanvas, getContext2D, releaseCanvas } from './canvas';
import { FORMAT_INFO, IMAGE_FORMATS, type EncodeSupport, type ImageFormat } from './types';

let cached: Promise<EncodeSupport> | null = null;

async function canEncode(format: ImageFormat): Promise<boolean> {
  const canvas = createCanvas(1, 1);
  if (!canvas) return false;
  try {
    const ctx = getContext2D(canvas);
    if (!ctx) return false;
    ctx.fillStyle = '#336699';
    ctx.fillRect(0, 0, 1, 1);
    const info = FORMAT_INFO[format];
    const blob = await canvasToBlob(canvas, info.mime, info.supportsQuality ? 0.9 : undefined);
    return !!blob && blob.size > 0 && blob.type === info.mime;
  } catch {
    return false;
  } finally {
    releaseCanvas(canvas);
  }
}

/**
 * Prüft im aktuellen Kontext (Worker oder Fenster), welche Formate der Browser wirklich kodiert,
 * indem je Format eine 1×1-Canvas kodiert und der MIME-Typ verglichen wird. Ergebnis wird gecacht.
 */
export function detectEncodeSupport(): Promise<EncodeSupport> {
  cached ??= (async () => {
    const entries = await Promise.all(IMAGE_FORMATS.map(async (f) => [f, await canEncode(f)] as const));
    return Object.freeze(Object.fromEntries(entries) as Record<ImageFormat, boolean>);
  })();
  return cached;
}
