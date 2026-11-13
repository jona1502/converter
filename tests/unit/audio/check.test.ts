import { describe, expect, it } from 'vitest';
import { checkAudioFile, checkAudioHeader } from '../../../src/lib/audio/check';
import { ascii, concat } from '../helpers/bytes';

const WAV = concat(ascii('RIFF'), Uint8Array.of(36, 0, 0, 0), ascii('WAVEfmt '));

function file(bytes: Uint8Array, name: string): File {
  return new File([bytes as Uint8Array<ArrayBuffer>], name);
}

describe('checkAudioHeader', () => {
  it('nimmt erkannte Signaturen unabhängig von der Endung an', () => {
    expect(checkAudioHeader('aufnahme.wav', 100, WAV, 1000)).toEqual({ ok: true, format: 'wav' });
    expect(checkAudioHeader('falsche-endung.mp3', 100, WAV, 1000)).toEqual({ ok: true, format: 'wav' });
  });

  it('meldet zu große Dateien vor der Signatur', () => {
    expect(checkAudioHeader('a.wav', 1001, WAV, 1000)).toEqual({ ok: false, code: 'file-too-large' });
  });

  it('unterscheidet M4A/AAC von sonstigen unbekannten Dateien', () => {
    const m4a = concat(new Uint8Array(4), ascii('ftypM4A '));
    expect(checkAudioHeader('memo.m4a', 12, m4a, 1000)).toEqual({ ok: false, code: 'aac-unsupported' });
    expect(checkAudioHeader('notiz.txt', 5, ascii('Hallo'), 1000)).toEqual({ ok: false, code: 'unsupported-type' });
    expect(checkAudioHeader('kaputt.mp3', 5, ascii('Hallo'), 1000)).toEqual({ ok: false, code: 'unsupported-type' });
  });
});

describe('checkAudioFile', () => {
  it('liest nur den Kopf der Datei', async () => {
    const large = concat(WAV, new Uint8Array(100_000));
    expect(await checkAudioFile(file(large, 'gross.wav'), 200_000)).toEqual({ ok: true, format: 'wav' });
    expect(await checkAudioFile(file(large, 'gross.wav'), 50_000)).toEqual({ ok: false, code: 'file-too-large' });
    expect(await checkAudioFile(file(ascii('kein Audio'), 'x.ogg'), 50_000)).toEqual({ ok: false, code: 'unsupported-type' });
  });
});
