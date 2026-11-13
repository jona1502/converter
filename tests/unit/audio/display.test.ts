import { describe, expect, it } from 'vitest';
import { formatChannels, formatDuration, formatDurationLimit, formatSampleRate } from '../../../src/lib/audio/display';

const S = ' ';

describe('formatDuration', () => {
  it('zeigt mm:ss mit gerundeten Sekunden', () => {
    expect(formatDuration(0)).toBe('00:00');
    expect(formatDuration(5)).toBe('00:05');
    expect(formatDuration(65.4)).toBe('01:05');
    expect(formatDuration(59.5)).toBe('01:00');
    expect(formatDuration(1800)).toBe('30:00');
    expect(formatDuration(4500)).toBe('75:00');
  });

  it('zeigt sehr kurze Dateien nicht als 00:00', () => {
    expect(formatDuration(0.25)).toBe('00:01');
    expect(formatDuration(0.001)).toBe('00:01');
  });

  it('lehnt ungültige Werte ab', () => {
    expect(() => formatDuration(-1)).toThrow(RangeError);
    expect(() => formatDuration(Number.NaN)).toThrow(RangeError);
  });

  it('beschreibt Grenzen in Minuten oder Sekunden', () => {
    expect(formatDurationLimit(1800)).toBe(`30${S}Minuten`);
    expect(formatDurationLimit(60)).toBe(`1${S}Minute`);
    expect(formatDurationLimit(90)).toBe(`90${S}Sekunden`);
  });
});

describe('formatSampleRate', () => {
  it('zeigt kHz deutsch formatiert', () => {
    expect(formatSampleRate(44100)).toBe(`44,1${S}kHz`);
    expect(formatSampleRate(48000)).toBe(`48${S}kHz`);
    expect(formatSampleRate(22050)).toBe(`22,05${S}kHz`);
    expect(formatSampleRate(11025)).toBe(`11,025${S}kHz`);
    expect(formatSampleRate(192000)).toBe(`192${S}kHz`);
  });

  it('lehnt ungültige Werte ab', () => {
    expect(() => formatSampleRate(0)).toThrow(RangeError);
    expect(() => formatSampleRate(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('formatChannels', () => {
  it('benennt Mono, Stereo und Mehrkanal', () => {
    expect(formatChannels(1)).toBe('Mono');
    expect(formatChannels(2)).toBe('Stereo');
    expect(formatChannels(6)).toBe(`6${S}Kanäle`);
    expect(() => formatChannels(0)).toThrow(RangeError);
    expect(() => formatChannels(1.5)).toThrow(RangeError);
  });
});
