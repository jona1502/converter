import { describe, expect, it } from 'vitest';
import { sniffAudio } from '../../../src/lib/audio/sniff';
import { ascii, concat } from '../helpers/bytes';

/** MPEG-1 Layer III, 128 kbit/s, 44,1 kHz ohne Padding: Framelänge 417 Bytes. */
const MP3_FRAME_HEADER = Uint8Array.of(0xff, 0xfb, 0x90, 0x00);

function mp3Frames(count: number): Uint8Array {
  const frame = new Uint8Array(417);
  frame.set(MP3_FRAME_HEADER);
  return concat(...Array.from({ length: count }, () => frame));
}

function wavHeader(): Uint8Array {
  return concat(ascii('RIFF'), Uint8Array.of(36, 0, 0, 0), ascii('WAVEfmt '));
}

function flacHeader(): Uint8Array {
  // STREAMINFO: Typ 0 (letzter Block), Länge 34.
  return concat(ascii('fLaC'), Uint8Array.of(0x80, 0, 0, 34), new Uint8Array(34));
}

function oggHeader(): Uint8Array {
  return concat(ascii('OggS'), Uint8Array.of(0, 0x02), new Uint8Array(20));
}

describe('sniffAudio', () => {
  it('erkennt WAV, FLAC, OGG und MP3 am Inhalt', () => {
    expect(sniffAudio(wavHeader())).toBe('wav');
    expect(sniffAudio(flacHeader())).toBe('flac');
    expect(sniffAudio(oggHeader())).toBe('ogg');
    expect(sniffAudio(concat(ascii('ID3'), Uint8Array.of(3, 0, 0, 0, 0, 0x10, 0x7f)))).toBe('mp3');
    expect(sniffAudio(mp3Frames(3))).toBe('mp3');
    // Folgeframe außerhalb des Kopfes: ein gültiger Framekopf genügt.
    expect(sniffAudio(MP3_FRAME_HEADER)).toBe('mp3');
  });

  it('lehnt andere RIFF-Formate, kaputte Köpfe und fremde Dateien ab', () => {
    expect(sniffAudio(concat(ascii('RIFF'), new Uint8Array(4), ascii('WEBPVP8 ')))).toBeNull();
    expect(sniffAudio(concat(ascii('fLaC'), Uint8Array.of(0x81, 0, 0, 34)))).toBeNull();
    expect(sniffAudio(concat(ascii('fLaC'), Uint8Array.of(0x00, 0, 0, 33)))).toBeNull();
    expect(sniffAudio(concat(ascii('OggS'), Uint8Array.of(1, 0x02)))).toBeNull();
    expect(sniffAudio(concat(ascii('OggS'), Uint8Array.of(0, 0x00)))).toBeNull();
    expect(sniffAudio(ascii('Hallo Welt'))).toBeNull();
    expect(sniffAudio(Uint8Array.of(0x89, 0x50, 0x4e, 0x47))).toBeNull();
    expect(sniffAudio(new Uint8Array(0))).toBeNull();
  });

  it('prüft ID3-Version, Revision und syncsafe-Größe', () => {
    expect(sniffAudio(concat(ascii('ID3'), Uint8Array.of(1, 0, 0, 0, 0, 0, 0)))).toBeNull();
    expect(sniffAudio(concat(ascii('ID3'), Uint8Array.of(5, 0, 0, 0, 0, 0, 0)))).toBeNull();
    expect(sniffAudio(concat(ascii('ID3'), Uint8Array.of(4, 0xff, 0, 0, 0, 0, 0)))).toBeNull();
    expect(sniffAudio(concat(ascii('ID3'), Uint8Array.of(4, 0, 0, 0x80, 0, 0, 0)))).toBeNull();
    expect(sniffAudio(ascii('ID3'))).toBeNull();
  });

  it('lehnt reservierte MPEG-Felder und ADTS/AAC ab', () => {
    expect(sniffAudio(Uint8Array.of(0xff, 0xeb, 0x90, 0x00))).toBeNull(); // Version reserviert
    expect(sniffAudio(Uint8Array.of(0xff, 0xf9, 0x90, 0x00))).toBeNull(); // Layer 0 (ADTS/AAC)
    expect(sniffAudio(Uint8Array.of(0xff, 0xf1, 0x50, 0x80))).toBeNull(); // ADTS-Kopf
    expect(sniffAudio(Uint8Array.of(0xff, 0xfb, 0x00, 0x00))).toBeNull(); // freie Bitrate
    expect(sniffAudio(Uint8Array.of(0xff, 0xfb, 0xf0, 0x00))).toBeNull(); // Bitrate ungültig
    expect(sniffAudio(Uint8Array.of(0xff, 0xfb, 0x9c, 0x00))).toBeNull(); // Abtastrate reserviert
  });

  it('verlangt einen passenden Folgeframe, wenn er im Kopf liegt', () => {
    const broken = mp3Frames(2);
    broken[417] = 0x00;
    expect(sniffAudio(broken)).toBeNull();
    const otherLayer = mp3Frames(2);
    otherLayer[418] = 0xfd; // Layer II statt III
    expect(sniffAudio(otherLayer)).toBeNull();
  });
});
