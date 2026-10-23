import { describe, expect, it } from 'vitest';
import { getConcurrency, LIMITS } from '../../src/lib/image/limits';

describe('LIMITS', () => {
  it('entspricht den Grenzwerten des Plans', () => {
    expect(LIMITS).toEqual({ maxFileBytes: 50 * 1024 * 1024, maxPixels: 40_000_000, maxEdge: 16384, maxFiles: 30, maxBmpOutputBytes: 100 * 1024 * 1024 });
  });
});

describe('getConcurrency', () => {
  it('nutzt 2 Plätze bei ausreichend Speicher und Kernen', () => {
    expect(getConcurrency({ deviceMemory: 8, hardwareConcurrency: 8 })).toBe(2);
  });

  it('nutzt 1 Platz bei wenig Speicher oder wenigen Kernen', () => {
    expect(getConcurrency({ deviceMemory: 4, hardwareConcurrency: 16 })).toBe(1);
    expect(getConcurrency({ deviceMemory: 0.5, hardwareConcurrency: 16 })).toBe(1);
    expect(getConcurrency({ deviceMemory: 8, hardwareConcurrency: 4 })).toBe(1);
  });

  it('ist robust bei fehlenden oder unplausiblen Angaben', () => {
    expect(getConcurrency({})).toBe(2);
    expect(getConcurrency({ deviceMemory: 'viel', hardwareConcurrency: Number.NaN })).toBe(2);
    expect(getConcurrency({ hardwareConcurrency: 0 })).toBe(2);
    expect([1, 2]).toContain(getConcurrency());
  });
});
