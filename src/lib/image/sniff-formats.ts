/**
 * Header-Auswertung für GIF, BMP, ICO und AVIF. Wie sniff.ts: grenzsicher, ohne Exceptions,
 * jede Schleife rückt garantiert vor.
 */
import { ascii, byte, has, i32le, positiveOrNull, u16le, u32be, u32le, writeU32le } from './bytes';
import type { SniffResult } from './sniff';

// ---------------------------------------------------------------- Erkennung

export function isGif(b: Uint8Array): boolean {
  const sig = ascii(b, 0, 6);
  return sig === 'GIF87a' || sig === 'GIF89a';
}

const BMP_HEADER_SIZES = new Set([12, 40, 52, 56, 64, 108, 124]);

/** "BM" allein ist zu schwach; zusätzlich muss die DIB-Headergröße eine bekannte sein. */
export function isBmp(b: Uint8Array): boolean {
  return has(b, 0, 18) && byte(b, 0) === 0x42 && byte(b, 1) === 0x4d && BMP_HEADER_SIZES.has(u32le(b, 14));
}

/** ICO: reserved 0, type 1 (Symbol; Cursor = 2 wird nicht unterstützt), mindestens ein Eintrag. */
export function isIco(b: Uint8Array): boolean {
  if (!has(b, 0, 6) || u16le(b, 0) !== 0 || u16le(b, 2) !== 1) return false;
  const count = u16le(b, 4);
  if (count < 1) return false;
  // Erster Eintrag muss plausibel sein, sofern vorhanden (Daten hinter dem Verzeichnis).
  if (has(b, 6, 16)) {
    const size = u32le(b, 6 + 8);
    const offset = u32le(b, 6 + 12);
    if (size === 0 || offset < 6 + 16 * count) return false;
  }
  return true;
}

function ftypBrands(b: Uint8Array): string[] | null {
  if (!has(b, 0, 16) || ascii(b, 4, 4) !== 'ftyp') return null;
  const size = u32be(b, 0);
  if (size < 16 || size > 4096) return null;
  const end = Math.min(size, b.length);
  const brands = [ascii(b, 8, 4)];
  for (let o = 16; o + 4 <= end; o += 4) brands.push(ascii(b, o, 4));
  return brands;
}

export function isAvif(b: Uint8Array): boolean {
  const brands = ftypBrands(b);
  return !!brands && (brands.includes('avif') || brands.includes('avis'));
}

// ---------------------------------------------------------------- GIF

function gifColorTableSize(packed: number): number {
  return packed & 0x80 ? 3 * 2 ** ((packed & 0x07) + 1) : 0;
}

/** Überspringt GIF-Unterblöcke ab off; liefert die Position hinter dem Terminator (oder > Länge). */
function skipSubBlocks(b: Uint8Array, off: number): number {
  let o = off;
  while (o < b.length) {
    const n = byte(b, o);
    o += 1;
    if (n === 0) return o;
    o += n;
  }
  return b.length + 1;
}

/**
 * GIF: Maße aus dem Logical Screen Descriptor (sonst erster Frame). Animiert = mehr als ein
 * Image Descriptor. Eine NETSCAPE-Schleifenerweiterung allein gilt nicht als Animation, weil
 * Browser solche Ein-Bild-GIFs unbewegt anzeigen.
 */
export function sniffGif(b: Uint8Array): SniffResult {
  let width = positiveOrNull(u16le(b, 6));
  let height = positiveOrNull(u16le(b, 8));
  let transparency = false;
  let animated = false;
  let complete = false;
  let frames = 0;

  if (!has(b, 0, 13)) {
    return { format: 'gif', width: null, height: null, orientation: 1, animated, mayHaveTransparency: false, complete };
  }
  let off = 13 + gifColorTableSize(byte(b, 10));
  while (off < b.length) {
    const type = byte(b, off);
    if (type === 0x2c) {
      frames++;
      if (frames > 1) {
        animated = true;
        complete = true;
        break;
      }
      if (!has(b, off, 10)) break;
      width ??= positiveOrNull(u16le(b, off + 5));
      height ??= positiveOrNull(u16le(b, off + 7));
      off += 10 + gifColorTableSize(byte(b, off + 9));
      off += 1; // LZW-Mindestcodegröße
      off = skipSubBlocks(b, off);
    } else if (type === 0x21) {
      const label = byte(b, off + 1);
      off += 2;
      if (label === 0xf9 && byte(b, off) >= 4 && has(b, off, 2) && byte(b, off + 1) & 0x01) transparency = true;
      off = skipSubBlocks(b, off);
    } else if (type === 0x3b) {
      complete = true;
      break;
    } else {
      // Unbekannter Block: Datei beschädigt, Auswertung beenden.
      complete = true;
      break;
    }
  }
  return { format: 'gif', width, height, orientation: 1, animated, mayHaveTransparency: transparency, complete };
}

// ---------------------------------------------------------------- BMP

interface DibInfo {
  readonly width: number | null;
  readonly height: number | null;
  readonly bitCount: number;
  readonly compression: number;
}

/** Liest einen DIB-Header (BITMAPCOREHEADER oder BITMAPINFOHEADER und Nachfolger) ab Position o. */
function readDib(b: Uint8Array, o: number): DibInfo | null {
  if (!has(b, o, 4)) return null;
  const size = u32le(b, o);
  if (size === 12) {
    if (!has(b, o, 12)) return null;
    return { width: positiveOrNull(u16le(b, o + 4)), height: positiveOrNull(u16le(b, o + 6)), bitCount: u16le(b, o + 10), compression: 0 };
  }
  if (!BMP_HEADER_SIZES.has(size) || !has(b, o, 20)) return null;
  const width = i32le(b, o + 4);
  const height = i32le(b, o + 8); // negativ = von oben nach unten gespeichert
  return {
    width: positiveOrNull(width),
    height: positiveOrNull(Math.abs(height)),
    bitCount: u16le(b, o + 14),
    compression: has(b, o, 20) ? u32le(b, o + 16) : 0,
  };
}

const BMP_BIT_COUNTS = new Set([1, 2, 4, 8, 16, 24, 32, 64]);

export function sniffBmp(b: Uint8Array): SniffResult {
  const dib = readDib(b, 14);
  const valid = !!dib && BMP_BIT_COUNTS.has(dib.bitCount);
  return {
    format: 'bmp',
    width: valid ? dib.width : null,
    height: valid ? dib.height : null,
    orientation: 1,
    animated: false,
    // 32 bit (Alpha je nach Maske/Browser) oder BI_ALPHABITFIELDS (6).
    mayHaveTransparency: valid && (dib.bitCount === 32 || dib.bitCount === 64 || dib.compression === 6),
    complete: dib !== null || b.length >= 14 + 124,
  };
}

// ---------------------------------------------------------------- ICO

export interface IcoEntry {
  /** Index im Verzeichnis. */
  readonly index: number;
  /** Maße laut Verzeichnis (0 = 256). */
  readonly dirWidth: number;
  readonly dirHeight: number;
  readonly bitCount: number;
  readonly size: number;
  readonly offset: number;
}

function readIcoEntries(b: Uint8Array): IcoEntry[] {
  const count = u16le(b, 4);
  const entries: IcoEntry[] = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    if (!has(b, e, 16)) break;
    entries.push({
      index: i,
      dirWidth: byte(b, e) || 256,
      dirHeight: byte(b, e + 1) || 256,
      bitCount: u16le(b, e + 6),
      size: u32le(b, e + 8),
      offset: u32le(b, e + 12),
    });
  }
  return entries;
}

/** Größter Eintrag (Fläche laut Verzeichnis, bei Gleichstand höhere Farbtiefe). */
export function selectLargestIcoEntry(b: Uint8Array): IcoEntry | null {
  let best: IcoEntry | null = null;
  for (const e of readIcoEntries(b)) {
    if (e.size === 0) continue;
    if (
      !best ||
      e.dirWidth * e.dirHeight > best.dirWidth * best.dirHeight ||
      (e.dirWidth * e.dirHeight === best.dirWidth * best.dirHeight && e.bitCount > best.bitCount)
    ) {
      best = e;
    }
  }
  return best;
}

function isPngAt(b: Uint8Array, o: number): boolean {
  return has(b, o, 8) && byte(b, o) === 0x89 && ascii(b, o + 1, 3) === 'PNG';
}

export function sniffIco(b: Uint8Array): SniffResult {
  const entry = selectLargestIcoEntry(b);
  const directoryComplete = has(b, 6, 16 * u16le(b, 4));
  let width: number | null = null;
  let height: number | null = null;
  let complete = false;
  if (entry && directoryComplete) {
    if (has(b, entry.offset, 32)) {
      complete = true;
      if (isPngAt(b, entry.offset)) {
        // Eingebettetes PNG: Maße aus dem IHDR (kann vom Verzeichnis abweichen).
        if (ascii(b, entry.offset + 12, 4) === 'IHDR') {
          width = positiveOrNull(u32be(b, entry.offset + 16));
          height = positiveOrNull(u32be(b, entry.offset + 20));
        }
      } else {
        // BMP-Eintrag: DIB-Header, Höhe enthält Farb- und AND-Maske (doppelt).
        const dib = readDib(b, entry.offset);
        if (dib && dib.width !== null && dib.height !== null) {
          width = dib.width;
          height = positiveOrNull(Math.floor(dib.height / 2));
        }
      }
    }
  } else if (directoryComplete) {
    complete = true;
  }
  return { format: 'ico', width, height, orientation: 1, animated: false, mayHaveTransparency: true, complete };
}

/**
 * Baut aus dem größten Eintrag ein ICO mit genau diesem einen Eintrag. So dekodiert der Browser
 * deterministisch den größten Eintrag (PNG- oder BMP-Eintrag samt AND-Maske). null bei Fehlern.
 */
export function extractLargestIcoEntry(b: Uint8Array): Uint8Array | null {
  const entry = selectLargestIcoEntry(b);
  if (!entry || !has(b, entry.offset, entry.size)) return null;
  const out = new Uint8Array(6 + 16 + entry.size);
  out.set(b.subarray(0, 4), 0); // reserved + type
  out[4] = 1;
  out.set(b.subarray(6 + entry.index * 16, 6 + entry.index * 16 + 12), 6);
  writeU32le(out, 6 + 12, 22);
  out.set(b.subarray(entry.offset, entry.offset + entry.size), 22);
  return out;
}

// ---------------------------------------------------------------- AVIF (ISOBMFF)

interface Box {
  readonly type: string;
  /** Beginn des Inhalts (nach Kopf). */
  readonly start: number;
  /** Ende der Box (kann hinter den vorhandenen Bytes liegen). */
  readonly end: number;
}

/** Liest die Boxen zwischen from und to. truncated = eine Box reicht über die vorhandenen Bytes. */
function readBoxes(b: Uint8Array, from: number, to: number): { boxes: Box[]; truncated: boolean } {
  const boxes: Box[] = [];
  let off = from;
  while (off + 8 <= to) {
    let size = u32be(b, off);
    const type = ascii(b, off + 4, 4);
    let header = 8;
    if (size === 1) {
      if (!has(b, off, 16)) return { boxes, truncated: true };
      size = u32be(b, off + 8) * 0x100000000 + u32be(b, off + 12);
      header = 16;
    } else if (size === 0) {
      size = to - off; // bis zum Ende
    }
    if (size < header) return { boxes, truncated: false }; // beschädigt
    const end = off + size;
    boxes.push({ type, start: off + header, end });
    if (end > b.length) return { boxes, truncated: true };
    off = end;
  }
  return { boxes, truncated: off < to };
}

const AVIF_CONTAINERS = new Set(['meta', 'iprp', 'ipco']);

/**
 * AVIF: Bildfolge ('avis'-Marke oder moov-Box) gilt als animiert. Maße: größte ispe-Angabe
 * (Primärbild bzw. Gitter ist mindestens so groß wie Kacheln/Vorschaubilder; obere Schranke für
 * die Grenzprüfung). irot mit 90°/270° tauscht die Maße. auxC (z. B. Alphaebene) → Transparenz möglich.
 */
export function sniffAvif(b: Uint8Array): SniffResult {
  const brands = ftypBrands(b) ?? [];
  let animated = brands.includes('avis');
  let transparency = false;
  let maxW = 0;
  let maxH = 0;
  let rotate = false;
  let sawMeta = false;
  let metaComplete = false;
  let truncated = false;

  const walk = (from: number, to: number, depth: number): void => {
    if (depth > 4) return;
    const result = readBoxes(b, from, to);
    if (result.truncated && depth === 0) truncated = true;
    for (const box of result.boxes) {
      const end = Math.min(box.end, b.length);
      if (box.type === 'moov') animated = true;
      else if (box.type === 'ispe' && has(b, box.start, 12)) {
        maxW = Math.max(maxW, u32be(b, box.start + 4));
        maxH = Math.max(maxH, u32be(b, box.start + 8));
      } else if (box.type === 'irot' && has(b, box.start, 1)) {
        if (byte(b, box.start) & 0x01) rotate = true;
      } else if (box.type === 'auxC') {
        transparency = true;
      } else if (AVIF_CONTAINERS.has(box.type)) {
        if (box.type === 'meta' && depth === 0) {
          sawMeta = true;
          metaComplete = box.end <= b.length;
        }
        // meta ist eine FullBox (4 Byte Version/Flags vor den Kindern).
        walk(box.type === 'meta' ? box.start + 4 : box.start, end, depth + 1);
      }
    }
  };
  walk(0, b.length, 0);

  const width = positiveOrNull(rotate ? maxH : maxW);
  const height = positiveOrNull(rotate ? maxW : maxH);
  return {
    format: 'avif',
    width,
    height,
    orientation: 1,
    animated,
    mayHaveTransparency: transparency,
    // Vollständig, sobald die meta-Box ganz gelesen ist; ohne meta erst am Dateiende.
    complete: animated || metaComplete || (!sawMeta && !truncated),
  };
}
