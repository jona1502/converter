/** Testhilfen: PDFs programmatisch mit pdf-lib erzeugen und Ergebnisse untersuchen. */
import {
  concatTransformationMatrix,
  decodePDFRawStream,
  drawObject,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  StandardFonts,
  type PDFPage,
} from '@cantoo/pdf-lib';

type Draw = (ctx: CanvasRenderingContext2D, width: number, height: number) => void;

async function canvasBytes(width: number, height: number, type: string, draw: Draw, quality?: number): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Kein 2D-Kontext');
  draw(ctx, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  if (!blob || blob.type !== type) throw new Error(`${type} nicht erzeugbar`);
  return new Uint8Array(await blob.arrayBuffer());
}

/** Detailreiches Bild: Verläufe, Kreise und deterministisches Rauschen (schlecht komprimierbar). */
export const detailed: Draw = (ctx, w, h) => {
  const gradient = ctx.createLinearGradient(0, 0, w, h);
  gradient.addColorStop(0, '#1d4ed8');
  gradient.addColorStop(0.5, '#f59e0b');
  gradient.addColorStop(1, '#059669');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);
  let seed = 12345;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < 400; i++) {
    ctx.fillStyle = `rgba(${Math.floor(rand() * 255)},${Math.floor(rand() * 255)},${Math.floor(rand() * 255)},0.5)`;
    ctx.beginPath();
    ctx.arc(rand() * w, rand() * h, 5 + rand() * (w / 10), 0, Math.PI * 2);
    ctx.fill();
  }
  const image = ctx.getImageData(0, 0, w, h);
  for (let i = 0; i < image.data.length; i += 4) {
    const n = (rand() - 0.5) * 60;
    image.data[i] = Math.max(0, Math.min(255, image.data[i]! + n));
    image.data[i + 1] = Math.max(0, Math.min(255, image.data[i + 1]! + n));
    image.data[i + 2] = Math.max(0, Math.min(255, image.data[i + 2]! + n));
  }
  ctx.putImageData(image, 0, 0);
};

export function jpegBytes(width: number, height: number, quality = 0.95, draw: Draw = detailed): Promise<Uint8Array> {
  return canvasBytes(width, height, 'image/jpeg', draw, quality);
}

/** PNG mit halbtransparentem Rand (Alphakanal). */
export function alphaPngBytes(width: number, height: number): Promise<Uint8Array> {
  return canvasBytes(width, height, 'image/png', (ctx, w, h) => {
    detailed(ctx, w, h);
    ctx.clearRect(0, 0, w / 4, h);
    ctx.fillStyle = 'rgba(255,0,0,0.4)';
    ctx.fillRect(0, 0, w / 4, h / 2);
  });
}

export function opaquePngBytes(width: number, height: number): Promise<Uint8Array> {
  return canvasBytes(width, height, 'image/png', detailed);
}

export const TEXT = 'Hallo PDF-Welt';

export async function newDocWithText(): Promise<{ doc: PDFDocument; page: PDFPage }> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(TEXT, { x: 50, y: 780, size: 24, font });
  page.drawRectangle({ x: 50, y: 700, width: 200, height: 40, borderColor: rgb(0.8, 0, 0), borderWidth: 3 });
  page.drawSvgPath('M 0 0 L 100 50 L 200 0 Z', { x: 50, y: 650, color: rgb(0, 0.4, 0.8) });
  return { doc, page };
}

/** Bindet einen Bild-Stream manuell ein und zeichnet ihn in widthPt × heightPt. */
export function placeImageStream(page: PDFPage, ref: PDFRef, x: number, y: number, widthPt: number, heightPt: number): void {
  const name = page.node.newXObject('Im', ref);
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(widthPt, 0, 0, heightPt, x, y),
    drawObject(name),
    popGraphicsState(),
  );
}

export async function save(doc: PDFDocument): Promise<Uint8Array> {
  return doc.save({ useObjectStreams: false });
}

export function toFile(bytes: Uint8Array, name = 'test.pdf'): File {
  return new File([bytes as Uint8Array<ArrayBuffer>], name, { type: 'application/pdf' });
}

export interface ImageXObjectInfo {
  readonly objectNumber: number;
  readonly width: number;
  readonly height: number;
  readonly filter: string;
  readonly colorSpace: string;
  readonly length: number;
  readonly contents: Uint8Array;
  readonly isMask: boolean;
}

/** Alle Bild-XObjects eines gespeicherten PDFs (inkl. Masken). */
export async function listImages(bytes: Uint8Array): Promise<ImageXObjectInfo[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  const maskRefs = new Set<number>();
  const out: ImageXObjectInfo[] = [];
  const objects = ctx.enumerateIndirectObjects();
  for (const [, obj] of objects) {
    if (obj instanceof PDFRawStream) {
      const smask = obj.dict.get(PDFName.of('SMask'));
      if (smask instanceof PDFRef) maskRefs.add(smask.objectNumber);
    }
  }
  for (const [ref, obj] of objects) {
    if (!(obj instanceof PDFRawStream) || obj.dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
    const num = (key: string): number => {
      const value = obj.dict.lookup(PDFName.of(key));
      return value instanceof PDFNumber ? value.asNumber() : -1;
    };
    const filter = obj.dict.lookup(PDFName.of('Filter'));
    const cs = obj.dict.lookup(PDFName.of('ColorSpace'));
    out.push({
      objectNumber: ref.objectNumber,
      width: num('Width'),
      height: num('Height'),
      filter: filter instanceof PDFName ? filter.decodeText() : filter instanceof PDFArray ? 'array' : 'none',
      colorSpace: cs instanceof PDFName ? cs.decodeText() : cs instanceof PDFArray ? 'array' : 'none',
      length: obj.getContentsSize(),
      contents: obj.getContents(),
      isMask: maskRefs.has(ref.objectNumber),
    });
  }
  return out.sort((a, b) => a.objectNumber - b.objectNumber);
}

/** Dekodierter Inhalt aller Content-Streams der Seiten als Text. */
export async function pageContentText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  let text = '';
  for (const page of doc.getPages()) {
    const contents = page.node.lookup(PDFName.of('Contents'));
    const streams = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents];
    for (const s of streams) {
      if (s instanceof PDFRawStream) text += new TextDecoder('latin1').decode(decodePDFRawStream(s).decode()) + '\n';
    }
  }
  return text;
}

export async function fontNames(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const names: string[] = [];
  for (const page of doc.getPages()) {
    const fonts = page.node.Resources()?.lookup(PDFName.of('Font'));
    if (!(fonts instanceof PDFDict)) continue;
    for (const value of fonts.values()) {
      const font = doc.context.lookup(value);
      const base = font instanceof PDFDict ? font.lookup(PDFName.of('BaseFont')) : undefined;
      if (base instanceof PDFName) names.push(base.decodeText());
    }
  }
  return names;
}

export async function pageCount(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPageCount();
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export { PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFDict, PDFArray };

/** Kurzname des Testbrowsers für Messausgaben. */
export function browserName(): string {
  const ua = navigator.userAgent;
  if (ua.includes('Firefox')) return 'firefox';
  if (ua.includes('Chrome')) return 'chromium';
  return 'webkit';
}
