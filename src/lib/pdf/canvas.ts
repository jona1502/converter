/**
 * Canvas-Abstraktion: im Worker OffscreenCanvas; im Fenster ohne OffscreenCanvas (z. B. Playwright-
 * WebKit unter Windows) HTMLCanvasElement – letzteres nur für direkte Aufrufe des Kerns in Tests.
 */
export type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
export type AnyContext2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export function createCanvas(width: number, height: number): AnyCanvas | null {
  try {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      return canvas;
    }
  } catch {
    // unzulässige Größe
  }
  return null;
}

export function getContext2D(canvas: AnyCanvas): AnyContext2D | null {
  try {
    return canvas.getContext('2d', { alpha: false }) as AnyContext2D | null;
  } catch {
    return null;
  }
}

export function releaseCanvas(canvas: AnyCanvas | null | undefined): void {
  if (!canvas) return;
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {
    // ignorieren
  }
}

export async function canvasToBlob(canvas: AnyCanvas, type: string, quality: number): Promise<Blob | null> {
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type, quality });
  }
  const element = canvas as HTMLCanvasElement;
  return new Promise<Blob | null>((resolve, reject) => {
    try {
      element.toBlob((blob) => resolve(blob), type, quality);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Prüft, ob der aktuelle Kontext Bilder neu kodieren und Streams (de)komprimieren kann.
 * requireOffscreen: im Worker gibt es kein HTMLCanvasElement.
 */
export function hasRecodeSupport(requireOffscreen: boolean): boolean {
  if (typeof createImageBitmap !== 'function') return false;
  if (typeof DecompressionStream === 'undefined' || typeof CompressionStream === 'undefined') return false;
  if (requireOffscreen && typeof OffscreenCanvas === 'undefined') return false;
  const canvas = createCanvas(1, 1);
  if (!canvas) return false;
  const ok = getContext2D(canvas) !== null;
  releaseCanvas(canvas);
  return ok;
}
