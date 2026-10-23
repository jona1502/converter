import { isWithinPixelLimits, LIMITS } from './limits';
import { ImageProcessingError, type Dimensions, type ResizeOptions } from './types';

export interface TargetSize {
  readonly width: number;
  readonly height: number;
  readonly upscaled: boolean;
}

function invalid(message: string): ImageProcessingError {
  return new ImageProcessingError('invalid-options', message);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (!isPositiveInteger(value)) throw invalid(`${name} muss eine positive Ganzzahl sein.`);
  return value;
}

function edge(value: number): number {
  return Math.max(1, Math.round(value));
}

/** Berechnet die Zielgröße nach den Regeln von ResizeOptions (siehe types.ts). Rein. */
export function computeTargetSize(source: Dimensions, resize: ResizeOptions): TargetSize {
  const sw = requirePositiveInteger(source?.width, 'Quellbreite');
  const sh = requirePositiveInteger(source?.height, 'Quellhöhe');
  if (resize === null || typeof resize !== 'object') throw invalid('Größenänderung fehlt.');

  let width: number;
  let height: number;

  switch (resize.mode) {
    case 'none':
      width = sw;
      height = sh;
      break;

    case 'percent': {
      const { percent } = resize;
      if (typeof percent !== 'number' || !Number.isFinite(percent) || percent <= 0) {
        throw invalid('Prozentwert muss eine endliche Zahl > 0 sein.');
      }
      if (percent > 100 && !resize.allowUpscale) throw invalid('Prozentwert > 100 erfordert allowUpscale.');
      width = edge((sw * percent) / 100);
      height = edge((sh * percent) / 100);
      break;
    }

    case 'dimensions': {
      const w = resize.width === undefined ? undefined : requirePositiveInteger(resize.width, 'Breite');
      const h = resize.height === undefined ? undefined : requirePositiveInteger(resize.height, 'Höhe');
      if (resize.keepAspectRatio) {
        let factor: number;
        if (w !== undefined && h !== undefined) factor = Math.min(w / sw, h / sh);
        else if (w !== undefined) factor = w / sw;
        else if (h !== undefined) factor = h / sh;
        else throw invalid('Breite oder Höhe ist erforderlich.');
        if (!resize.allowUpscale) factor = Math.min(factor, 1);
        width = edge(sw * factor);
        height = edge(sh * factor);
      } else {
        if (w === undefined || h === undefined) throw invalid('Ohne Seitenverhältnis sind Breite und Höhe erforderlich.');
        width = resize.allowUpscale ? w : Math.min(w, sw);
        height = resize.allowUpscale ? h : Math.min(h, sh);
      }
      break;
    }

    case 'maxEdge': {
      const max = requirePositiveInteger(resize.maxEdge, 'Maximale Kantenlänge');
      const longest = Math.max(sw, sh);
      if (longest <= max) {
        width = sw;
        height = sh;
      } else {
        const factor = max / longest;
        width = sw >= sh ? max : edge(sw * factor);
        height = sh > sw ? max : edge(sh * factor);
      }
      break;
    }

    default:
      throw invalid('Unbekannter Modus der Größenänderung.');
  }

  if (!isWithinPixelLimits(width, height)) {
    throw new ImageProcessingError(
      'dimensions-too-large',
      `Zielgröße ${width} × ${height} px überschreitet ${LIMITS.maxPixels} px bzw. ${LIMITS.maxEdge} px je Kante.`,
    );
  }

  return { width, height, upscaled: width > sw || height > sh };
}
