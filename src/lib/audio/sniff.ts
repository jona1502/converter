/**
 * Clientseitige Vorprüfung von Audiodateien anhand der ersten Bytes, ohne Dekodierung.
 * Die Regeln entsprechen der Annahmeprüfung des Servers (server/internal/jobs/audio_signatures.go):
 * Was hier abgelehnt wird, würde der Server mit 415 ablehnen. Dauer, Kanäle, Abtastrate und
 * Kodierung prüft erst der Server.
 */
import type { AudioFormat } from './formats';

/** So viele Bytes liest auch der Server für die Erkennung. */
export const AUDIO_SNIFF_BYTES = 4096;

function startsWith(bytes: Uint8Array, text: string, offset = 0): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index++) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

/** RIFF-Container mit Formtyp WAVE (WebP und AVI teilen sich RIFF). */
function isWav(bytes: Uint8Array): boolean {
  return startsWith(bytes, 'RIFF') && startsWith(bytes, 'WAVE', 8);
}

/** „fLaC“; der erste Metadatenblock muss STREAMINFO (Typ 0, 34 Bytes) sein, soweit enthalten. */
function isFlac(bytes: Uint8Array): boolean {
  if (!startsWith(bytes, 'fLaC')) return false;
  if (bytes.length < 8) return true;
  const length = (bytes[5]! << 16) | (bytes[6]! << 8) | bytes[7]!;
  return (bytes[4]! & 0x7f) === 0 && length === 34;
}

/** Seitenkopf „OggS“, Strukturversion 0 und (falls enthalten) Flag „beginning of stream“. */
function isOgg(bytes: Uint8Array): boolean {
  if (bytes.length < 5 || !startsWith(bytes, 'OggS') || bytes[4] !== 0) return false;
  return bytes.length < 6 || (bytes[5]! & 0x02) !== 0;
}

/** ID3v2.2–2.4-Tag (Revision ≠ 0xff, Größe als syncsafe-Integer). */
function isId3(bytes: Uint8Array): boolean {
  if (bytes.length < 10 || !startsWith(bytes, 'ID3')) return false;
  if (bytes[3]! < 2 || bytes[3]! > 4 || bytes[4] === 0xff) return false;
  return bytes.subarray(6, 10).every((value) => value < 0x80);
}

// Kbit/s je Bitratenindex 1–14 (0 = frei und 15 = ungültig werden abgelehnt), Zeilen: Layer I, II, III.
const BITRATE_V1 = [
  [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
] as const;
const BITRATE_V2 = [
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
] as const;
/** Abtastraten nach Versionsbits (0 = MPEG-2.5, 2 = MPEG-2, 3 = MPEG-1). */
const MPEG_RATES: Readonly<Record<number, readonly [number, number, number]>> = {
  0: [11025, 12000, 8000],
  2: [22050, 24000, 16000],
  3: [44100, 48000, 32000],
};

interface MpegHeader {
  readonly version: number;
  readonly layer: number;
  /** Framelänge in Bytes. */
  readonly length: number;
}

function parseMpegHeader(bytes: Uint8Array): MpegHeader | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || (bytes[1]! & 0xe0) !== 0xe0) return null;
  const version = (bytes[1]! >> 3) & 3;
  const layer = (bytes[1]! >> 1) & 3;
  const bitrateIndex = bytes[2]! >> 4;
  const rateIndex = (bytes[2]! >> 2) & 3;
  const padding = (bytes[2]! >> 1) & 1;
  // Version 1 ist reserviert, Layer 0 ebenso (ADTS/AAC nutzt Layer 0).
  if (version === 1 || layer === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const table = version === 3 ? BITRATE_V1 : BITRATE_V2;
  const bitrate = table[3 - layer]![bitrateIndex]! * 1000;
  const rate = MPEG_RATES[version]![rateIndex]!;
  let length: number;
  if (layer === 3) length = (Math.trunc((12 * bitrate) / rate) + padding) * 4;
  else if (layer === 1 && version !== 3) length = Math.trunc((72 * bitrate) / rate) + padding;
  else length = Math.trunc((144 * bitrate) / rate) + padding;
  return { version, layer, length };
}

/** Gültiger Framekopf am Anfang; liegt der Folgeframe im Kopf, muss er zu Version und Layer passen. */
function isMpegStream(bytes: Uint8Array): boolean {
  const first = parseMpegHeader(bytes);
  if (!first) return false;
  if (first.length + 4 > bytes.length) return true;
  const next = parseMpegHeader(bytes.subarray(first.length));
  return next !== null && next.version === first.version && next.layer === first.layer;
}

/** Erkennt das Audioformat an den ersten Bytes (höchstens AUDIO_SNIFF_BYTES), sonst null. */
export function sniffAudio(head: Uint8Array): AudioFormat | null {
  const bytes = head.subarray(0, AUDIO_SNIFF_BYTES);
  if (isWav(bytes)) return 'wav';
  if (isFlac(bytes)) return 'flac';
  if (isOgg(bytes)) return 'ogg';
  if (isId3(bytes) || isMpegStream(bytes)) return 'mp3';
  return null;
}
