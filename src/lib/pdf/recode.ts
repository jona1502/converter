/**
 * Neukodierung einzelner Bild-XObjects mit nativen Browser-APIs.
 */
import { PDFNumber, type PDFContext, type PDFRawStream } from '@cantoo/pdf-lib';
import { canvasToBlob, createCanvas, getContext2D, releaseCanvas, type AnyCanvas, type AnyContext2D } from './canvas';
import { N, type ImageRecord } from './document';
import { readJpegFrame, stripJpegApp1 } from './jpeg';
import type { Placement } from './placement';
import { MAX_REPLACEMENT_RATIO } from './presets';
import { inflate, undoPngPredictor } from './streams';
import { PdfProcessingError, type PdfQualityPreset } from './types';

/**
 * Skalierungsfaktor (0 < s ≤ 1) für ein Bild:
 * - mit bekannter Darstellung: so, dass beide Achsen mindestens targetDpi behalten,
 * - immer: längste Kante ≤ maxImageEdge,
 * - Faktoren über minDownscaleFactor werden zu 1 (keine Neuabtastung).
 */
export function computeScale(
  width: number,
  height: number,
  placement: Placement | undefined,
  preset: PdfQualityPreset,
): number {
  let scale = 1;
  if (placement) {
    const sx = (preset.targetDpi * placement.widthPt) / 72 / width;
    const sy = (preset.targetDpi * placement.heightPt) / 72 / height;
    scale = Math.min(1, Math.max(sx, sy));
  }
  scale = Math.min(scale, preset.maxImageEdge / Math.max(width, height));
  return scale > preset.minDownscaleFactor ? 1 : scale;
}

export function targetSize(width: number, height: number, scale: number): { width: number; height: number } {
  if (scale >= 1) return { width, height };
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

type Source =
  | { readonly kind: 'bitmap'; readonly bitmap: ImageBitmap }
  | { readonly kind: 'canvas'; readonly canvas: AnyCanvas };

function closeSource(source: Source | null): void {
  if (!source) return;
  if (source.kind === 'bitmap') source.bitmap.close();
  else releaseCanvas(source.canvas);
}

function sourceImage(source: Source): CanvasImageSource {
  return source.kind === 'bitmap' ? source.bitmap : (source.canvas as CanvasImageSource);
}

/** Entpackt Flate- bzw. unkomprimierte Rasterdaten mit genau width*height*components Bytes. */
async function readRaw(
  stream: PDFRawStream,
  compressed: boolean,
  width: number,
  height: number,
  components: number,
  pngPredictor: boolean,
): Promise<Uint8Array | null> {
  const rowBytes = width * components + (pngPredictor ? 1 : 0);
  const expected = rowBytes * height;
  let data: Uint8Array;
  if (compressed) {
    const { bytes, complete } = await inflate(stream.getContents(), expected);
    if (!complete) return null;
    data = bytes;
  } else {
    data = stream.getContents();
  }
  if (data.length < expected) return null;
  if (pngPredictor) return undoPngPredictor(data, width, height, components);
  return data.length === expected ? data : data.subarray(0, expected);
}

function rawToCanvas(raw: Uint8Array, width: number, height: number, components: 1 | 3): AnyCanvas | null {
  const canvas = createCanvas(width, height);
  const ctx = canvas ? getContext2D(canvas) : null;
  if (!canvas || !ctx) {
    releaseCanvas(canvas);
    return null;
  }
  const image = ctx.createImageData(width, height);
  const px = image.data;
  const count = width * height;
  if (components === 3) {
    for (let i = 0, j = 0, k = 0; i < count; i++, j += 3, k += 4) {
      px[k] = raw[j]!;
      px[k + 1] = raw[j + 1]!;
      px[k + 2] = raw[j + 2]!;
      px[k + 3] = 255;
    }
  } else {
    for (let i = 0, k = 0; i < count; i++, k += 4) {
      const v = raw[i]!;
      px[k] = v;
      px[k + 1] = v;
      px[k + 2] = v;
      px[k + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

async function decodeImage(record: ImageRecord): Promise<Source | null> {
  const components = record.color === 'rgb' ? 3 : 1;
  if (record.filter === 'dct') {
    const bytes = stripJpegApp1(record.stream.getContents());
    const frame = readJpegFrame(bytes);
    if (!frame || frame.precision !== 8 || frame.components !== components) return null;
    if (frame.width !== record.width || frame.height !== record.height) return null;
    let bitmap: ImageBitmap;
    try {
      // colorSpaceConversion 'none': PDF-Reader werten eingebettete ICC-Profile im JPEG nicht aus,
      // die Kanalwerte müssen daher unverändert bleiben.
      bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }), {
        colorSpaceConversion: 'none',
        premultiplyAlpha: 'none',
      });
    } catch {
      return null;
    }
    if (bitmap.width !== record.width || bitmap.height !== record.height) {
      bitmap.close();
      return null;
    }
    return { kind: 'bitmap', bitmap };
  }
  const raw = await readRaw(record.stream, record.filter === 'flate', record.width, record.height, components, record.pngPredictor);
  if (!raw) return null;
  const canvas = rawToCanvas(raw, record.width, record.height, components);
  return canvas ? { kind: 'canvas', canvas } : null;
}

function drawScaled(source: CanvasImageSource, sw: number, sh: number, tw: number, th: number): AnyCanvas {
  // Schrittweise halbieren: einfache bilineare Filter (v. a. Firefox) erzeugen sonst Aliasing.
  let current = source;
  let cw = sw;
  let ch = sh;
  let temp: AnyCanvas | null = null;
  try {
    while (cw >= tw * 4 && ch >= th * 4) {
      const nw = Math.ceil(cw / 2);
      const nh = Math.ceil(ch / 2);
      const next = createCanvas(nw, nh);
      const nctx = next ? getContext2D(next) : null;
      if (!next || !nctx) {
        releaseCanvas(next);
        break;
      }
      smooth(nctx);
      nctx.drawImage(current, 0, 0, nw, nh);
      releaseCanvas(temp);
      temp = next;
      current = next as CanvasImageSource;
      cw = nw;
      ch = nh;
    }
    const canvas = createCanvas(tw, th);
    const ctx = canvas ? getContext2D(canvas) : null;
    if (!canvas || !ctx) {
      releaseCanvas(canvas);
      throw new PdfProcessingError('memory-limit', `Canvas ${tw}×${th} nicht verfügbar.`);
    }
    smooth(ctx);
    ctx.drawImage(current, 0, 0, tw, th);
    return canvas;
  } finally {
    releaseCanvas(temp);
  }
}

function smooth(ctx: AnyContext2D): void {
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
}

async function encodeJpeg(canvas: AnyCanvas, quality: number): Promise<Uint8Array> {
  const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
  if (!blob || blob.size === 0) throw new PdfProcessingError('memory-limit', 'JPEG-Kodierung lieferte kein Ergebnis.');
  if (blob.type !== 'image/jpeg') throw new PdfProcessingError('unsupported-browser', `Browser kodiert kein JPEG (${blob.type}).`);
  return new Uint8Array(await blob.arrayBuffer());
}

export type RecodeOutcome = 'recompressed' | 'resized' | 'not-smaller' | 'skipped';

/**
 * Kodiert ein Bild neu und ersetzt den Stream, wenn das Ergebnis kleiner ist
 * (≤ MAX_REPLACEMENT_RATIO der alten Bytes). Maskierte Bilder werden nicht verändert.
 */
export async function recodeImage(
  _context: PDFContext,
  record: ImageRecord,
  placement: Placement | undefined,
  preset: PdfQualityPreset,
): Promise<RecodeOutcome> {
  if (record.skip !== null || record.color === null) return 'skipped';
  const scale = computeScale(record.width, record.height, placement, preset);
  const target = targetSize(record.width, record.height, scale);
  const resized = target.width !== record.width || target.height !== record.height;

  let source: Source | null = null;
  let canvas: AnyCanvas | null = null;
  let jpeg: Uint8Array;
  try {
    source = await decodeImage(record);
    if (!source) return 'skipped';
    if (resized) {
      canvas = drawScaled(sourceImage(source), record.width, record.height, target.width, target.height);
    } else if (source.kind === 'canvas') {
      canvas = source.canvas;
      source = null;
    } else {
      canvas = drawScaled(source.bitmap, record.width, record.height, record.width, record.height);
    }
    closeSource(source);
    source = null;
    jpeg = await encodeJpeg(canvas, preset.jpegQuality);
  } finally {
    closeSource(source);
    releaseCanvas(canvas);
  }

  if (jpeg.length > record.bytes * MAX_REPLACEMENT_RATIO) return 'not-smaller';

  const dict = record.stream.dict;
  record.stream.updateContents(jpeg);
  dict.set(N.Filter, N.DCTDecode);
  dict.delete(N.DecodeParms);
  dict.delete(N.Decode);
  dict.set(N.Width, PDFNumber.of(target.width));
  dict.set(N.Height, PDFNumber.of(target.height));
  dict.set(N.BitsPerComponent, PDFNumber.of(8));
  // Browser-JPEGs sind immer dreikanalig; Graustufen werden daher als DeviceRGB gespeichert.
  if (!record.keepColorSpace) dict.set(N.ColorSpace, N.DeviceRGB);
  dict.set(N.Length, PDFNumber.of(jpeg.length));

  return resized ? 'resized' : 'recompressed';
}

