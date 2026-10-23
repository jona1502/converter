import { describe, expect, it } from 'vitest';
import { FORMAT_INFO, IMAGE_FORMATS } from '../../src/lib/image/types';

describe('FORMAT_INFO', () => {
  it('beschreibt jedes unterstützte Format', () => {
    for (const format of IMAGE_FORMATS) {
      expect(FORMAT_INFO[format].mime).toBe(`image/${format}`);
    }
  });

  it('bietet bei PNG keine Qualitätsregelung an', () => {
    expect(FORMAT_INFO.png.supportsQuality).toBe(false);
  });
});
