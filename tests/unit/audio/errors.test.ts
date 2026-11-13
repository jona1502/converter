import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../src/lib/api/client';
import { audioErrorMessage, audioServerMessage } from '../../../src/components/tools/errorMessages';

const limits = { maxFileBytes: 104_857_600, maxDurationSeconds: 1800, maxChannels: 8, maxSampleRate: 192_000, maxOutputBytes: 419_430_400 };

describe('audioErrorMessage', () => {
  it('erklärt die neuen Audiocodes mit den Servergrenzen', () => {
    expect(audioErrorMessage('duration-too-long', limits)).toContain('30 Minuten');
    const unsupported = audioErrorMessage('unsupported-audio', limits);
    expect(unsupported).toContain('8 Kanäle');
    expect(unsupported).toContain('192 kHz');
    expect(unsupported).toContain('Mono');
  });

  it('erklärt bestehende Codes audiospezifisch', () => {
    expect(audioErrorMessage('file-too-large', limits)).toContain('104,9 MB');
    expect(audioErrorMessage('unsupported-type', limits)).toContain('MP3, WAV, FLAC und OGG');
    expect(audioErrorMessage('aac-unsupported', limits)).toContain('M4A');
    expect(audioErrorMessage('decode-failed', limits)).toContain('beschädigt');
    expect(audioErrorMessage('result-too-large', limits)).toContain('419,4 MB');
    expect(audioErrorMessage('timeout', limits)).toContain('Zeitlimit');
  });

  it('liefert für unbekannte Codes null', () => {
    expect(audioErrorMessage('server-busy', limits)).toBeNull();
  });
});

describe('audioServerMessage', () => {
  it('nutzt Audiotexte für bekannte Codes und sonst die allgemeine Meldung', () => {
    expect(audioServerMessage(new ApiError('duration-too-long'), limits)).toContain('30 Minuten');
    expect(audioServerMessage(new ApiError('storage-full', 507), limits)).toBe(new ApiError('storage-full').message);
    expect(audioServerMessage(new TypeError('fetch'), limits)).toContain('nicht erreichbar');
  });
});
