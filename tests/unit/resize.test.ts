import { describe, expect, it } from 'vitest';
import { computeTargetSize } from '../../src/lib/image/resize';
import { ImageProcessingError, type ImageErrorCode, type ResizeOptions } from '../../src/lib/image/types';

const src = { width: 4000, height: 3000 };

function codeOf(fn: () => unknown): ImageErrorCode | null {
  try {
    fn();
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(ImageProcessingError);
    return (e as ImageProcessingError).code;
  }
}

describe('computeTargetSize', () => {
  it('none: unverändert', () => {
    expect(computeTargetSize(src, { mode: 'none' })).toEqual({ width: 4000, height: 3000, upscaled: false });
  });

  it('percent: rundet, Mindestwert 1, Vergrößerung nur mit allowUpscale', () => {
    expect(computeTargetSize(src, { mode: 'percent', percent: 50, allowUpscale: false })).toEqual({ width: 2000, height: 1500, upscaled: false });
    expect(computeTargetSize({ width: 3, height: 5 }, { mode: 'percent', percent: 50, allowUpscale: false })).toEqual({ width: 2, height: 3, upscaled: false });
    expect(computeTargetSize({ width: 1, height: 1 }, { mode: 'percent', percent: 1, allowUpscale: false })).toEqual({ width: 1, height: 1, upscaled: false });
    expect(computeTargetSize({ width: 100, height: 50 }, { mode: 'percent', percent: 150, allowUpscale: true })).toEqual({ width: 150, height: 75, upscaled: true });
    expect(computeTargetSize({ width: 100, height: 50 }, { mode: 'percent', percent: 100, allowUpscale: false }).upscaled).toBe(false);
    expect(codeOf(() => computeTargetSize(src, { mode: 'percent', percent: 150, allowUpscale: false }))).toBe('invalid-options');
    for (const percent of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(codeOf(() => computeTargetSize(src, { mode: 'percent', percent, allowUpscale: true }))).toBe('invalid-options');
    }
  });

  it('dimensions proportional: eine Angabe leitet die andere ab', () => {
    expect(computeTargetSize(src, { mode: 'dimensions', width: 1000, keepAspectRatio: true, allowUpscale: false })).toEqual({ width: 1000, height: 750, upscaled: false });
    expect(computeTargetSize(src, { mode: 'dimensions', height: 1000, keepAspectRatio: true, allowUpscale: false })).toEqual({ width: 1333, height: 1000, upscaled: false });
  });

  it('dimensions proportional: beide Angaben -> contain', () => {
    expect(computeTargetSize(src, { mode: 'dimensions', width: 1000, height: 1000, keepAspectRatio: true, allowUpscale: false })).toEqual({ width: 1000, height: 750, upscaled: false });
    expect(computeTargetSize(src, { mode: 'dimensions', width: 2000, height: 600, keepAspectRatio: true, allowUpscale: false })).toEqual({ width: 800, height: 600, upscaled: false });
  });

  it('dimensions proportional: Vergrößerung begrenzt oder erlaubt', () => {
    const small = { width: 200, height: 100 };
    expect(computeTargetSize(small, { mode: 'dimensions', width: 400, keepAspectRatio: true, allowUpscale: false })).toEqual({ width: 200, height: 100, upscaled: false });
    expect(computeTargetSize(small, { mode: 'dimensions', width: 400, keepAspectRatio: true, allowUpscale: true })).toEqual({ width: 400, height: 200, upscaled: true });
    expect(computeTargetSize(small, { mode: 'dimensions', width: 400, height: 150, keepAspectRatio: true, allowUpscale: true })).toEqual({ width: 300, height: 150, upscaled: true });
  });

  it('dimensions exakt: verzerrt, jede Kante einzeln begrenzt', () => {
    expect(computeTargetSize(src, { mode: 'dimensions', width: 500, height: 500, keepAspectRatio: false, allowUpscale: false })).toEqual({ width: 500, height: 500, upscaled: false });
    expect(computeTargetSize({ width: 200, height: 100 }, { mode: 'dimensions', width: 300, height: 50, keepAspectRatio: false, allowUpscale: false })).toEqual({ width: 200, height: 50, upscaled: false });
    expect(computeTargetSize({ width: 200, height: 100 }, { mode: 'dimensions', width: 300, height: 50, keepAspectRatio: false, allowUpscale: true })).toEqual({ width: 300, height: 50, upscaled: true });
  });

  it('dimensions: ungültige Angaben', () => {
    const cases: ResizeOptions[] = [
      { mode: 'dimensions', keepAspectRatio: true, allowUpscale: false },
      { mode: 'dimensions', width: 100, keepAspectRatio: false, allowUpscale: false },
      { mode: 'dimensions', width: 0, keepAspectRatio: true, allowUpscale: false },
      { mode: 'dimensions', width: 10.5, keepAspectRatio: true, allowUpscale: false },
      { mode: 'dimensions', height: -1, keepAspectRatio: true, allowUpscale: false },
      { mode: 'dimensions', width: Number.NaN, height: 10, keepAspectRatio: false, allowUpscale: false },
    ];
    for (const c of cases) expect(codeOf(() => computeTargetSize(src, c))).toBe('invalid-options');
  });

  it('maxEdge: längste Kante begrenzt, kleinere Bilder unverändert', () => {
    expect(computeTargetSize(src, { mode: 'maxEdge', maxEdge: 1000 })).toEqual({ width: 1000, height: 750, upscaled: false });
    expect(computeTargetSize({ width: 3000, height: 4000 }, { mode: 'maxEdge', maxEdge: 1000 })).toEqual({ width: 750, height: 1000, upscaled: false });
    expect(computeTargetSize({ width: 1001, height: 3 }, { mode: 'maxEdge', maxEdge: 1000 })).toEqual({ width: 1000, height: 3, upscaled: false });
    expect(computeTargetSize({ width: 5000, height: 1 }, { mode: 'maxEdge', maxEdge: 100 })).toEqual({ width: 100, height: 1, upscaled: false });
    expect(computeTargetSize({ width: 800, height: 600 }, { mode: 'maxEdge', maxEdge: 1000 })).toEqual({ width: 800, height: 600, upscaled: false });
    expect(codeOf(() => computeTargetSize(src, { mode: 'maxEdge', maxEdge: 0 }))).toBe('invalid-options');
    expect(codeOf(() => computeTargetSize(src, { mode: 'maxEdge', maxEdge: 99.5 }))).toBe('invalid-options');
  });

  it('lehnt Ziele über den Grenzwerten ab', () => {
    expect(codeOf(() => computeTargetSize(src, { mode: 'percent', percent: 200, allowUpscale: true }))).toBe('dimensions-too-large');
    expect(codeOf(() => computeTargetSize({ width: 100, height: 10 }, { mode: 'dimensions', width: 16385, keepAspectRatio: true, allowUpscale: true }))).toBe('dimensions-too-large');
    expect(computeTargetSize({ width: 100, height: 10 }, { mode: 'dimensions', width: 16384, keepAspectRatio: true, allowUpscale: true })).toEqual({ width: 16384, height: 1638, upscaled: true });
  });

  it('lehnt unbekannte Modi ab', () => {
    expect(codeOf(() => computeTargetSize(src, { mode: 'cover' } as unknown as ResizeOptions))).toBe('invalid-options');
  });
});
