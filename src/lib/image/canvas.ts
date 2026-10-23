/**
 * Kleine Abstraktion über OffscreenCanvas (Worker und Fenster) und HTMLCanvasElement (Rückfall im Fenster).
 */
export type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
export type AnyContext2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export function hasOffscreenCanvas(): boolean {
  return typeof OffscreenCanvas !== 'undefined';
}

/** Erzeugt eine Canvas oder null, wenn im Kontext keine verfügbar ist bzw. die Größe abgelehnt wird. */
export function createCanvas(width: number, height: number): AnyCanvas | null {
  try {
    if (hasOffscreenCanvas()) return new OffscreenCanvas(width, height);
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      return canvas;
    }
  } catch {
    // z. B. RangeError bei unzulässiger Größe
  }
  return null;
}

export function getContext2D(canvas: AnyCanvas): AnyContext2D | null {
  try {
    return canvas.getContext('2d') as AnyContext2D | null;
  } catch {
    return null;
  }
}

/** Gibt den Pixelspeicher frei (hilft besonders Safari mit seinem Canvas-Gesamtbudget). */
export function releaseCanvas(canvas: AnyCanvas | null | undefined): void {
  if (!canvas) return;
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {
    // ignorieren
  }
}

/** Kodiert die Canvas. Liefert null, wenn der Browser kein Ergebnis erzeugt. */
export async function canvasToBlob(canvas: AnyCanvas, type: string, quality?: number): Promise<Blob | null> {
  if (hasOffscreenCanvas() && canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob(quality === undefined ? { type } : { type, quality });
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

/** Ob im aktuellen Kontext dekodiert und auf eine Canvas gezeichnet werden kann. */
export function canProcessInContext(): boolean {
  if (typeof createImageBitmap !== 'function') return false;
  const canvas = createCanvas(1, 1);
  if (!canvas) return false;
  const ok = getContext2D(canvas) !== null;
  releaseCanvas(canvas);
  return ok;
}
