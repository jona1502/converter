/**
 * Formaterkennung und Header-Auswertung anhand der Dateibytes (nicht Endung oder MIME-Typ).
 *
 * Alle Leser prüfen Grenzen selbst; abgeschnittene oder fehlerhafte Daten führen zu
 * fehlenden Angaben (null), nie zu Exceptions oder Endlosschleifen.
 */
import type { ImageFormat } from './types';

export interface SniffResult {
  readonly format: ImageFormat;
  /** Breite laut Header (vor Anwendung der EXIF-Orientierung), null wenn nicht ermittelbar. */
  readonly width: number | null;
  /** Höhe laut Header (vor Anwendung der EXIF-Orientierung), null wenn nicht ermittelbar. */
  readonly height: number | null;
  /** EXIF-Orientierung 1..8 (nur JPEG ausgewertet). */
  readonly orientation: number;
  readonly animated: boolean;
  readonly mayHaveTransparency: boolean;
  /**
   * true, wenn alle für die Prüfung relevanten Header-Teile in den Bytes lagen.
   * false bedeutet: die Bytes endeten vorher, mit mehr Daten könnte das Ergebnis vollständiger sein.
   */
  readonly complete: boolean;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function byte(b: Uint8Array, o: number): number {
  return b[o] ?? 0;
}

function has(b: Uint8Array, o: number, n: number): boolean {
  return o >= 0 && o + n <= b.length;
}

function ascii(b: Uint8Array, o: number, n: number): string {
  if (!has(b, o, n)) return '';
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(byte(b, o + i));
  return s;
}

function u16be(b: Uint8Array, o: number): number {
  return (byte(b, o) << 8) | byte(b, o + 1);
}

function u16le(b: Uint8Array, o: number): number {
  return byte(b, o) | (byte(b, o + 1) << 8);
}

function u24le(b: Uint8Array, o: number): number {
  return byte(b, o) | (byte(b, o + 1) << 8) | (byte(b, o + 2) << 16);
}

function u32be(b: Uint8Array, o: number): number {
  return byte(b, o) * 0x1000000 + ((byte(b, o + 1) << 16) | (byte(b, o + 2) << 8) | byte(b, o + 3));
}

function u32le(b: Uint8Array, o: number): number {
  return byte(b, o + 3) * 0x1000000 + ((byte(b, o + 2) << 16) | (byte(b, o + 1) << 8) | byte(b, o));
}

function positiveOrNull(n: number): number | null {
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Erkennt JPEG, PNG oder WebP an der Signatur; sonst null. */
export function detectFormat(b: Uint8Array): ImageFormat | null {
  if (has(b, 0, 3) && byte(b, 0) === 0xff && byte(b, 1) === 0xd8 && byte(b, 2) === 0xff) return 'jpeg';
  if (has(b, 0, 8) && PNG_SIGNATURE.every((v, i) => byte(b, i) === v)) return 'png';
  if (has(b, 0, 12) && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  return null;
}

/** Wertet den Header aus. null, wenn keine unterstützte Signatur vorliegt. */
export function sniffImage(b: Uint8Array): SniffResult | null {
  switch (detectFormat(b)) {
    case 'png':
      return sniffPng(b);
    case 'jpeg':
      return sniffJpeg(b);
    case 'webp':
      return sniffWebp(b);
    default:
      return null;
  }
}

function sniffPng(b: Uint8Array): SniffResult {
  let width: number | null = null;
  let height: number | null = null;
  let transparency = false;
  let animated = false;
  let complete = false;

  // IHDR muss der erste Chunk sein: Länge(4) Typ(4) Breite(4) Höhe(4) Bittiefe(1) Farbtyp(1) ...
  if (has(b, 8, 8 + 13) && ascii(b, 12, 4) === 'IHDR' && u32be(b, 8) >= 13) {
    width = positiveOrNull(u32be(b, 16));
    height = positiveOrNull(u32be(b, 20));
    const colorType = byte(b, 25);
    transparency = colorType === 4 || colorType === 6;

    let off = 8;
    while (has(b, off, 8)) {
      const length = u32be(b, off);
      const type = ascii(b, off + 4, 4);
      if (type === 'IDAT' || type === 'IEND' || length > 0x7fffffff) {
        // Animations- und Transparenz-Chunks stehen vor IDAT; ungültige Länge beendet die Suche.
        complete = true;
        break;
      }
      if (type === 'acTL') animated = true;
      else if (type === 'tRNS') transparency = true;
      off += 12 + length;
    }
  } else if (b.length >= 8 + 8 + 13) {
    // Genug Bytes, aber kein gültiger IHDR: Abmessungen nicht ermittelbar.
    complete = true;
  }

  return { format: 'png', width, height, orientation: 1, animated, mayHaveTransparency: transparency, complete };
}

function isSofMarker(m: number): boolean {
  return m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
}

function sniffJpeg(b: Uint8Array): SniffResult {
  let width: number | null = null;
  let height: number | null = null;
  let orientation = 1;
  let orientationFound = false;
  let complete = false;

  let off = 2;
  while (off < b.length) {
    if (byte(b, off) !== 0xff) {
      // Kein Marker an erwarteter Stelle: tolerant bis zum nächsten 0xFF weitersuchen.
      off++;
      continue;
    }
    // Füllbytes 0xFF überspringen.
    while (off < b.length && byte(b, off) === 0xff) off++;
    if (off >= b.length) break;
    const marker = byte(b, off);
    off++;

    // Marker ohne Längenfeld.
    if (marker === 0x00 || marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    // Bilddaten oder Dateiende vor einem SOF: keine Abmessungen ermittelbar.
    if (marker === 0xda || marker === 0xd9) {
      complete = true;
      break;
    }
    if (!has(b, off, 2)) break;
    const length = u16be(b, off);
    if (length < 2) {
      complete = true;
      break;
    }
    const segStart = off + 2;
    const segEnd = off + length;

    if (isSofMarker(marker)) {
      // Präzision(1) Höhe(2) Breite(2)
      if (has(b, segStart, 5)) {
        height = positiveOrNull(u16be(b, segStart + 1));
        width = positiveOrNull(u16be(b, segStart + 3));
        complete = true;
      }
      break;
    }
    if (marker === 0xe1 && !orientationFound) {
      const found = parseExifOrientation(b, segStart, Math.min(segEnd, b.length));
      if (found !== null) {
        orientation = found;
        orientationFound = true;
      }
    }
    off = segEnd;
  }

  return { format: 'jpeg', width, height, orientation, animated: false, mayHaveTransparency: false, complete };
}

/** Liest die Orientierung (Tag 0x0112) aus IFD0 eines EXIF-APP1-Segments. null = kein EXIF. */
function parseExifOrientation(b: Uint8Array, start: number, end: number): number | null {
  if (end - start < 14 || ascii(b, start, 6) !== 'Exif\0\0') return null;
  const t = start + 6;
  const little = byte(b, t) === 0x49 && byte(b, t + 1) === 0x49;
  const big = byte(b, t) === 0x4d && byte(b, t + 1) === 0x4d;
  if (!little && !big) return null;
  const r16 = (o: number): number => (little ? u16le(b, o) : u16be(b, o));
  const r32 = (o: number): number => (little ? u32le(b, o) : u32be(b, o));
  if (r16(t + 2) !== 42) return null;
  const ifd = t + r32(t + 4);
  if (ifd + 2 > end) return 1;
  const count = r16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) break;
    if (r16(entry) === 0x0112) {
      const type = r16(entry + 2);
      if (type !== 3) return 1;
      const value = r16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

function sniffWebp(b: Uint8Array): SniffResult {
  let width: number | null = null;
  let height: number | null = null;
  let animated = false;
  let transparency = false;
  let complete = false;
  let hasVp8x = false;
  let first = true;

  let off = 12;
  while (has(b, off, 8)) {
    const type = ascii(b, off, 4);
    const size = u32le(b, off + 4);
    const data = off + 8;

    if (type === 'VP8X') {
      if (first && has(b, data, 10)) {
        hasVp8x = true;
        const flags = byte(b, data);
        if (flags & 0x02) animated = true;
        if (flags & 0x10) transparency = true;
        width = positiveOrNull(1 + u24le(b, data + 4));
        height = positiveOrNull(1 + u24le(b, data + 7));
        complete = true;
      }
    } else if (type === 'VP8 ') {
      if (!hasVp8x && width === null && has(b, data, 10)) {
        const keyFrame = (byte(b, data) & 0x01) === 0;
        const startCode = byte(b, data + 3) === 0x9d && byte(b, data + 4) === 0x01 && byte(b, data + 5) === 0x2a;
        if (keyFrame && startCode) {
          width = positiveOrNull(u16le(b, data + 6) & 0x3fff);
          height = positiveOrNull(u16le(b, data + 8) & 0x3fff);
        }
        complete = true;
      }
    } else if (type === 'VP8L') {
      if (!hasVp8x && width === null && has(b, data, 5)) {
        if (byte(b, data) === 0x2f) {
          const bits = u32le(b, data + 1);
          width = (bits & 0x3fff) + 1;
          height = (Math.floor(bits / 0x4000) & 0x3fff) + 1;
          if (Math.floor(bits / 0x10000000) & 0x01) transparency = true;
        }
        complete = true;
      }
    } else if (type === 'ALPH') {
      transparency = true;
    } else if (type === 'ANIM' || type === 'ANMF') {
      animated = true;
    }

    if (first && !complete) {
      // Erster Chunk ist kein bekannter Bild-Chunk oder unvollständig.
      if (type !== 'VP8X' && type !== 'VP8 ' && type !== 'VP8L') complete = true;
    }
    first = false;
    off = data + size + (size & 1);
  }

  return { format: 'webp', width, height, orientation: 1, animated, mayHaveTransparency: transparency, complete };
}
