/** Erzeugung von Testbildern: per Canvas gerendert oder gezielt aus Bytes zusammengesetzt. */
import type { ImageFormat } from '../../../src/lib/image/types';
import { ascii, blobBytes, concat, crc32, u16be, u16le, u24le, u32be, u32le } from './bytes';

const MIME: Record<ImageFormat, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

type Draw = (ctx: CanvasRenderingContext2D, width: number, height: number) => void;

/** Rendert per Canvas. Liefert null, wenn der Browser das Format nicht kodiert. */
export async function renderBlob(
  format: ImageFormat,
  width: number,
  height: number,
  draw: Draw,
  quality?: number,
): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Kein 2D-Kontext');
  draw(ctx, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, MIME[format], quality));
  return blob && blob.type === MIME[format] ? blob : null;
}

export async function renderRequired(format: ImageFormat, width: number, height: number, draw: Draw): Promise<Blob> {
  const blob = await renderBlob(format, width, height, draw, 0.92);
  if (!blob) throw new Error(`Testbild ${format} konnte nicht erzeugt werden`);
  return blob;
}

export const fill =
  (color: string): Draw =>
  (ctx, w, h) => {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, w, h);
  };

/** Linke Hälfte transparent, rechte Hälfte deckend grün. */
export const halfTransparent: Draw = (ctx, w, h) => {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#00ff00';
  ctx.fillRect(Math.floor(w / 2), 0, w - Math.floor(w / 2), h);
};

/** Linke Hälfte rot, rechte Hälfte blau (zur Prüfung der Orientierung). */
export const redLeftBlueRight: Draw = (ctx, w, h) => {
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, 0, Math.floor(w / 2), h);
  ctx.fillStyle = '#0000ff';
  ctx.fillRect(Math.floor(w / 2), 0, w - Math.floor(w / 2), h);
};

/** Deterministisches Rauschen (detailreich, schlecht komprimierbar). */
export const noise =
  (seed = 1): Draw =>
  (ctx, w, h) => {
    const data = ctx.createImageData(w, h);
    let s = seed >>> 0 || 1;
    for (let i = 0; i < data.data.length; i += 4) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      data.data[i] = s & 0xff;
      data.data[i + 1] = (s >>> 8) & 0xff;
      data.data[i + 2] = (s >>> 16) & 0xff;
      data.data[i + 3] = 255;
    }
    ctx.putImageData(data, 0, 0);
  };

/** Liest ein Pixel aus einem kodierten Bild (RGBA). */
export async function readPixel(blob: Blob, x: number, y: number): Promise<[number, number, number, number]> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Kein 2D-Kontext');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const d = ctx.getImageData(x, y, 1, 1).data;
  return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, d[3] ?? 0];
}

// ---------------------------------------------------------------- PNG

export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeAndData = concat(ascii(type), data);
  return concat(u32be(data.length), typeAndData, u32be(crc32(typeAndData)));
}

/** Fügt einen Chunk direkt hinter IHDR ein (Signatur 8 + IHDR 25 Bytes). */
export function insertPngChunkAfterIhdr(png: Uint8Array, chunk: Uint8Array): Uint8Array {
  return concat(png.subarray(0, 33), chunk, png.subarray(33));
}

/**
 * Baut ein echtes RGBA-PNG (Farbtyp 6) per CompressionStream – auch für vollständig deckende
 * Inhalte, die ein Canvas-Encoder als RGB ohne Alpha speichern würde.
 */
export async function makeRgbaPng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number, number],
): Promise<Uint8Array> {
  const raw = new Uint8Array(height * (1 + width * 4));
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // Filter: none
    for (let x = 0; x < width; x++) {
      raw.set(pixel(x, y), o);
      o += 4;
    }
  }
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'));
  const zlib = new Uint8Array(await new Response(stream).arrayBuffer());
  const ihdr = concat(u32be(width), u32be(height), Uint8Array.of(8, 6, 0, 0, 0));
  return concat(
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib),
    pngChunk('IEND', new Uint8Array(0)),
  );
}

/** APNG-Kennung: acTL (Anzahl Frames, Wiederholungen) vor IDAT. */
export function makeApng(png: Uint8Array): Uint8Array {
  return insertPngChunkAfterIhdr(png, pngChunk('acTL', concat(u32be(2), u32be(0))));
}

/** Schreibt andere Abmessungen in den IHDR (mit korrekter CRC), ohne die Bilddaten zu ändern. */
export function setPngDimensions(png: Uint8Array, width: number, height: number): Uint8Array {
  const out = png.slice();
  out.set(u32be(width), 16);
  out.set(u32be(height), 20);
  out.set(u32be(crc32(out.subarray(12, 29))), 29);
  return out;
}

// ---------------------------------------------------------------- JPEG

/** EXIF-APP1-Segment mit nur dem Orientierungs-Tag in IFD0. */
export function exifApp1(orientation: number, littleEndian = false): Uint8Array {
  const w16 = littleEndian ? u16le : u16be;
  const w32 = littleEndian ? u32le : u32be;
  const tiff = concat(
    littleEndian ? ascii('II') : ascii('MM'),
    w16(42),
    w32(8),
    w16(1), // ein Eintrag
    w16(0x0112),
    w16(3), // SHORT
    w32(1),
    w16(orientation),
    w16(0),
    w32(0), // kein weiteres IFD
  );
  const payload = concat(ascii('Exif\0\0'), tiff);
  return concat(Uint8Array.of(0xff, 0xe1), u16be(payload.length + 2), payload);
}

/** Fügt ein Segment direkt hinter SOI ein. */
export function insertJpegSegment(jpeg: Uint8Array, segment: Uint8Array): Uint8Array {
  return concat(jpeg.subarray(0, 2), segment, jpeg.subarray(2));
}

/** APP2-Segment mit Füllinhalt (maximal 65533 Nutzbytes). */
export function paddingSegment(size: number): Uint8Array {
  return concat(Uint8Array.of(0xff, 0xe2), u16be(size + 2), new Uint8Array(size));
}

/** Position des SOF-Segments (Offset des Markers 0xFF) in einem JPEG. */
function findSof(jpeg: Uint8Array): number {
  let off = 2;
  while (off + 4 <= jpeg.length) {
    if (jpeg[off] !== 0xff) throw new Error('Unerwartete JPEG-Struktur');
    const marker = jpeg[off + 1] as number;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return off;
    off += 2 + (((jpeg[off + 2] as number) << 8) | (jpeg[off + 3] as number));
  }
  throw new Error('Kein SOF gefunden');
}

export function setJpegDimensions(jpeg: Uint8Array, width: number, height: number): Uint8Array {
  const out = jpeg.slice();
  const sof = findSof(out);
  out.set(u16be(height), sof + 5);
  out.set(u16be(width), sof + 7);
  return out;
}

/** Schneidet das JPEG unmittelbar hinter dem SOF-Segment ab (Header lesbar, keine Bilddaten). */
export function truncateJpegAfterSof(jpeg: Uint8Array): Uint8Array {
  const sof = findSof(jpeg);
  const length = ((jpeg[sof + 2] as number) << 8) | (jpeg[sof + 3] as number);
  return jpeg.slice(0, sof + 2 + length);
}

// ---------------------------------------------------------------- WebP

function riff(chunks: Uint8Array[]): Uint8Array {
  const body = concat(ascii('WEBP'), ...chunks);
  return concat(ascii('RIFF'), u32le(body.length), body);
}

function webpChunk(type: string, data: Uint8Array): Uint8Array {
  const pad = data.length % 2 === 1 ? Uint8Array.of(0) : new Uint8Array(0);
  return concat(ascii(type), u32le(data.length), data, pad);
}

/** Nur Header: verlustbehafteter VP8-Keyframe mit Abmessungen (nicht dekodierbar). */
export function webpVp8Header(width: number, height: number): Uint8Array {
  const data = concat(Uint8Array.of(0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a), u16le(width), u16le(height), new Uint8Array(8));
  return riff([webpChunk('VP8 ', data)]);
}

/** Nur Header: verlustfreier VP8L mit Abmessungen und Alpha-Hinweisbit. */
export function webpVp8lHeader(width: number, height: number, alpha: boolean): Uint8Array {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14) | ((alpha ? 1 : 0) << 28);
  return riff([webpChunk('VP8L', concat(Uint8Array.of(0x2f), u32le(bits >>> 0), new Uint8Array(4)))]);
}

/** Erweitertes WebP (VP8X) mit Flags, optional ANIM-Chunk. */
export function webpVp8x(options: {
  width: number;
  height: number;
  animatedFlag?: boolean;
  alphaFlag?: boolean;
  animChunk?: boolean;
  alphChunk?: boolean;
}): Uint8Array {
  const flags = (options.animatedFlag ? 0x02 : 0) | (options.alphaFlag ? 0x10 : 0);
  const chunks = [webpChunk('VP8X', concat(Uint8Array.of(flags, 0, 0, 0), u24le(options.width - 1), u24le(options.height - 1)))];
  if (options.animChunk) chunks.push(webpChunk('ANIM', new Uint8Array(6)));
  if (options.alphChunk) chunks.push(webpChunk('ALPH', new Uint8Array(4)));
  chunks.push(webpChunk('VP8 ', concat(Uint8Array.of(0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a), u16le(options.width), u16le(options.height))));
  return riff(chunks);
}

/** Gültiges, dekodierbares 1×1-WebP (verlustfrei, mit Alpha). */
export const TINY_WEBP_BASE64 = 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';

export async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return blobBytes(blob);
}
