import { describe, expect, it } from 'vitest';
import { formatBytes, formatRetention, formatSizeChange } from '../../src/lib/format';

const S = ' ';
const M = '−';

describe('formatBytes', () => {
  it('nutzt KB unter 1.000.000 Bytes und MB ab 1.000.000 Bytes (dezimal, deutsch)', () => {
    expect(formatBytes(0)).toBe(`0${S}KB`);
    expect(formatBytes(1)).toBe(`<${S}0,1${S}KB`);
    expect(formatBytes(49)).toBe(`<${S}0,1${S}KB`);
    expect(formatBytes(50)).toBe(`0,1${S}KB`);
    expect(formatBytes(400)).toBe(`0,4${S}KB`);
    expect(formatBytes(1000)).toBe(`1${S}KB`);
    expect(formatBytes(1500)).toBe(`1,5${S}KB`);
    expect(formatBytes(9_949)).toBe(`9,9${S}KB`);
    expect(formatBytes(12_345)).toBe(`12${S}KB`);
    expect(formatBytes(999_499)).toBe(`999${S}KB`);
    expect(formatBytes(1_000_000)).toBe(`1${S}MB`);
    expect(formatBytes(1_234_567)).toBe(`1,23${S}MB`);
    expect(formatBytes(12_345_678)).toBe(`12,3${S}MB`);
    expect(formatBytes(100_000_000)).toBe(`100${S}MB`);
    expect(formatBytes(1_234_500_000)).toBe(`1.234,5${S}MB`);
  });

  it('zeigt 999.500–999.999 Bytes nicht als „1.000 KB“', () => {
    expect(formatBytes(999_500)).toBe(`999${S}KB`);
    expect(formatBytes(999_999)).toBe(`999${S}KB`);
  });

  it('lehnt ungültige Werte ab', () => {
    expect(() => formatBytes(-1)).toThrow(RangeError);
    expect(() => formatBytes(Number.NaN)).toThrow(RangeError);
    expect(() => formatBytes(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('formatSizeChange', () => {
  it('formatiert Verkleinerung, Vergrößerung und Gleichstand', () => {
    expect(formatSizeChange(1000, 580)).toMatchObject({ percent: `${M}42${S}%`, kind: 'smaller' });
    expect(formatSizeChange(1000, 1035)).toMatchObject({ percent: `+3,5${S}%`, kind: 'larger' });
    expect(formatSizeChange(1000, 1000)).toEqual({ percent: `0${S}%`, value: 0, kind: 'equal' });
    expect(formatSizeChange(1000, 0)).toMatchObject({ percent: `${M}100${S}%`, kind: 'smaller' });
    expect(formatSizeChange(1000, 3000)).toMatchObject({ percent: `+200${S}%`, kind: 'larger' });
    expect(formatSizeChange(10_000, 9_955)).toMatchObject({ percent: `${M}0,45${S}%`, kind: 'smaller' });
  });

  it('zeigt winzige Änderungen nie als 0 %', () => {
    expect(formatSizeChange(10_000_000, 9_999_999)).toMatchObject({ percent: `<${S}0,01${S}%`, kind: 'smaller' });
    expect(formatSizeChange(10_000_000, 10_000_001)).toMatchObject({ percent: `<${S}0,01${S}%`, kind: 'larger' });
  });

  it('lehnt ungültige Werte ab', () => {
    expect(() => formatSizeChange(0, 10)).toThrow(RangeError);
    expect(() => formatSizeChange(10, -1)).toThrow(RangeError);
  });
});

describe('formatRetention', () => {
  it('formatiert Aufbewahrungsdauern', () => {
    expect(formatRetention(3600)).toBe(`1${S}Stunde`);
    expect(formatRetention(7200)).toBe(`2${S}Stunden`);
    expect(formatRetention(1800)).toBe(`30${S}Minuten`);
    expect(formatRetention(86_400)).toBe(`1${S}Tag`);
    expect(formatRetention(45)).toBe(`45${S}Sekunden`);
    expect(formatRetention(0)).toBe('');
    expect(formatRetention(Number.NaN)).toBe('');
  });
});
