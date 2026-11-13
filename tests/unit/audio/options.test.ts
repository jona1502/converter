import { describe, expect, it } from 'vitest';
import { buildAudioOptions, qualityApplies } from '../../../src/lib/audio/options';
import { audioAcceptAttribute, hasAacExtension } from '../../../src/lib/audio/formats';

describe('buildAudioOptions', () => {
  it('sendet die Qualität (0–1) nur bei MP3 und OGG', () => {
    expect(buildAudioOptions({ format: 'mp3', quality: 80, channels: 'original' })).toEqual({
      tool: 'audio-convert', format: 'mp3', channels: 'original', quality: 0.8,
    });
    expect(buildAudioOptions({ format: 'ogg', quality: 35, channels: 'mono' })).toEqual({
      tool: 'audio-convert', format: 'ogg', channels: 'mono', quality: 0.35,
    });
    expect(buildAudioOptions({ format: 'wav', quality: 35, channels: 'original' })).toEqual({
      tool: 'audio-convert', format: 'wav', channels: 'original',
    });
    expect(buildAudioOptions({ format: 'flac', quality: 80, channels: 'mono' })).toEqual({
      tool: 'audio-convert', format: 'flac', channels: 'mono',
    });
  });

  it('begrenzt die Qualität auf 0–100 % und ersetzt ungültige Werte durch den Standard', () => {
    expect(buildAudioOptions({ format: 'mp3', quality: 0, channels: 'original' }).quality).toBe(0);
    expect(buildAudioOptions({ format: 'mp3', quality: 100, channels: 'original' }).quality).toBe(1);
    expect(buildAudioOptions({ format: 'mp3', quality: 140, channels: 'original' }).quality).toBe(1);
    expect(buildAudioOptions({ format: 'mp3', quality: -3, channels: 'original' }).quality).toBe(0);
    expect(buildAudioOptions({ format: 'mp3', quality: Number.NaN, channels: 'original' }).quality).toBe(0.8);
  });

  it('folgt den vom Server gemeldeten Qualitätsformaten', () => {
    expect(qualityApplies('mp3')).toBe(true);
    expect(qualityApplies('wav')).toBe(false);
    expect(qualityApplies('ogg', ['mp3'])).toBe(false);
    expect(buildAudioOptions({ format: 'ogg', quality: 50, channels: 'original' }, ['mp3'])).not.toHaveProperty('quality');
  });

  it('serialisiert gleiche Einstellungen identisch (stabiler Idempotenzschlüssel)', () => {
    const a = JSON.stringify(buildAudioOptions({ format: 'wav', quality: 10, channels: 'original' }));
    const b = JSON.stringify(buildAudioOptions({ format: 'wav', quality: 90, channels: 'original' }));
    expect(a).toBe(b);
  });
});

describe('Audio-Endungen', () => {
  it('bietet Endungen und MIME-Typen aller Eingabeformate an', () => {
    const accept = audioAcceptAttribute().split(',');
    for (const part of ['.mp3', '.wav', '.flac', '.ogg', '.oga', '.opus', 'audio/mpeg', 'audio/wav', 'audio/flac', 'audio/ogg']) {
      expect(accept).toContain(part);
    }
    expect(accept).not.toContain('.m4a');
    expect(accept.some((part) => part.includes('aac'))).toBe(false);
  });

  it('erkennt M4A- und AAC-Endungen ohne Rücksicht auf Groß-/Kleinschreibung', () => {
    expect(hasAacExtension('Sprachmemo.M4A')).toBe(true);
    expect(hasAacExtension('podcast.aac')).toBe(true);
    expect(hasAacExtension('lied.mp3')).toBe(false);
    expect(hasAacExtension('m4a')).toBe(false);
  });
});
