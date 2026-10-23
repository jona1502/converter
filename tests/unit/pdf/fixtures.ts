/** Test-PDFs. Alle Bytes werden im Browser erzeugt; es gibt keine Fixture-Dateien. */
import { PDFDocument, PDFName, type PDFPage, type PDFRef } from '@cantoo/pdf-lib';
import { alphaPngBytes, jpegBytes, newDocWithText, opaquePngBytes, placeImageStream, save } from './helpers';

/** Nur Text und Vektorgrafik. */
export async function textOnlyPdf(): Promise<Uint8Array> {
  const { doc } = await newDocWithText();
  return save(doc);
}

export interface MixedPdf {
  readonly bytes: Uint8Array;
  /** Anzeigegröße des großen JPEGs in pt. */
  readonly jpegPt: { readonly width: number; readonly height: number };
}

/**
 * Text, Vektor, großes detailreiches JPEG (2400×1800, q 0,95, dargestellt 500×375 pt ≈ 346 dpi),
 * Flate-RGB-Bild aus PNG (800×600 auf 200×150 pt) und PNG mit Alphakanal (Flate + SMask).
 * Zwei Seiten; das JPEG wird auf Seite 2 zusätzlich kleiner wiederverwendet.
 */
export async function mixedPdf(): Promise<MixedPdf> {
  const { doc, page } = await newDocWithText();
  const jpeg = await doc.embedJpg(await jpegBytes(2400, 1800, 0.95));
  page.drawImage(jpeg, { x: 50, y: 250, width: 500, height: 375 });
  const png = await doc.embedPng(await opaquePngBytes(800, 600));
  page.drawImage(png, { x: 50, y: 60, width: 200, height: 150 });
  const alpha = await doc.embedPng(await alphaPngBytes(600, 400));
  page.drawImage(alpha, { x: 300, y: 60, width: 150, height: 100 });
  const page2 = doc.addPage([595, 842]);
  page2.drawImage(jpeg, { x: 50, y: 500, width: 200, height: 150 });
  return { bytes: await save(doc), jpegPt: { width: 500, height: 375 } };
}

function register(doc: PDFDocument, contents: Uint8Array, dict: Record<string, unknown>, flate: boolean): PDFRef {
  const ctx = doc.context;
  const stream = flate
    ? ctx.flateStream(contents, dict as Parameters<typeof ctx.flateStream>[1])
    : ctx.stream(contents, dict as Parameters<typeof ctx.stream>[1]);
  return ctx.register(stream);
}

/** Rauschen in Grau oder RGB, Zeilen optional mit PNG-Filtern (Sub/Up/Average/Paeth im Wechsel). */
export function rasterBytes(width: number, height: number, components: number, predictor: boolean): Uint8Array {
  const rowBytes = width * components;
  const plain = new Uint8Array(rowBytes * height);
  let seed = 99;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < rowBytes; x++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      plain[y * rowBytes + x] = Math.floor((x * 180) / rowBytes + (y * 60) / height + (seed >>> 28));
    }
  }
  if (!predictor) return plain;
  const out = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const filter = y % 5; // 0..4
    out[y * (rowBytes + 1)] = filter;
    for (let x = 0; x < rowBytes; x++) {
      const raw = plain[y * rowBytes + x]!;
      const left = x >= components ? plain[y * rowBytes + x - components]! : 0;
      const up = y > 0 ? plain[(y - 1) * rowBytes + x]! : 0;
      const upLeft = y > 0 && x >= components ? plain[(y - 1) * rowBytes + x - components]! : 0;
      let pred = 0;
      if (filter === 1) pred = left;
      else if (filter === 2) pred = up;
      else if (filter === 3) pred = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      out[y * (rowBytes + 1) + 1 + x] = (raw - pred) & 0xff;
    }
  }
  return out;
}

export interface SpecialPdf {
  readonly bytes: Uint8Array;
  /** Objektnummern der Bilder, die unverändert bleiben müssen, mit erwartetem Grund. */
  readonly unsupported: ReadonlyMap<number, string>;
  /** Objektnummern neu kodierbarer Bilder. */
  readonly supported: ReadonlyMap<number, string>;
  readonly unreferencedObject: number;
  readonly plainContentObject: number;
}

/**
 * Sonderfälle: nicht unterstützte Bilder (Indexed, 1 bit, JPX, CMYK-JPEG, Decode-Array, Farbschlüssel-
 * Maske, TIFF-Predictor), unterstützte Sonderformen (Flate mit PNG-Predictor, Graustufen, unkomprimiert),
 * ein unreferenziertes Objekt und ein unkomprimierter Content-Stream.
 */
export async function specialPdf(): Promise<SpecialPdf> {
  const { doc, page } = await newDocWithText();
  const unsupported = new Map<number, string>();
  const supported = new Map<number, string>();
  const jpeg = await jpegBytes(400, 300, 0.95);
  const place = (ref: PDFRef, i: number, target: PDFPage = page): void =>
    placeImageStream(target, ref, 20 + (i % 5) * 110, 20 + Math.floor(i / 5) * 110, 100, 75);
  const base = { Type: 'XObject', Subtype: 'Image', BitsPerComponent: 8 };
  let i = 0;
  const add = (map: Map<number, string>, label: string, ref: PDFRef): void => {
    map.set(ref.objectNumber, label);
    place(ref, i++);
  };

  const indexedCs = doc.context.obj([PDFName.of('Indexed'), PDFName.of('DeviceRGB'), 1, doc.context.register(doc.context.stream(new Uint8Array([255, 0, 0, 0, 0, 255])))]);
  add(unsupported, 'colorspace', register(doc, rasterBytes(64, 64, 1, false).map((v) => v & 1), { ...base, Width: 64, Height: 64, ColorSpace: indexedCs }, true));
  add(unsupported, 'bits-per-component', register(doc, new Uint8Array(8 * 64).fill(0xaa), { ...base, Width: 64, Height: 64, BitsPerComponent: 1, ColorSpace: 'DeviceGray' }, true));
  add(unsupported, 'filter', register(doc, new Uint8Array(5000).fill(7), { ...base, Width: 200, Height: 200, ColorSpace: 'DeviceRGB', Filter: 'JPXDecode' }, false));
  add(unsupported, 'cmyk', register(doc, jpeg, { ...base, Width: 400, Height: 300, ColorSpace: 'DeviceCMYK', Filter: 'DCTDecode', Decode: [1, 0, 1, 0, 1, 0, 1, 0] }, false));
  add(unsupported, 'decode-array', register(doc, jpeg, { ...base, Width: 400, Height: 300, ColorSpace: 'DeviceRGB', Filter: 'DCTDecode', Decode: [1, 0, 1, 0, 1, 0] }, false));
  add(unsupported, 'mask', register(doc, jpeg, { ...base, Width: 400, Height: 300, ColorSpace: 'DeviceRGB', Filter: 'DCTDecode', Mask: [0, 10, 0, 10, 0, 10] }, false));
  const profile = doc.context.register(doc.context.stream(new Uint8Array(128), { N: 3 }));
  add(unsupported, 'colorspace', register(doc, jpeg, { ...base, Width: 400, Height: 300, ColorSpace: doc.context.obj([PDFName.of('ICCBased'), profile]), Filter: 'DCTDecode' }, false));
  add(unsupported, 'decode-parms', register(doc, rasterBytes(300, 200, 3, true), { ...base, Width: 300, Height: 200, ColorSpace: 'DeviceRGB', DecodeParms: { Predictor: 16, Colors: 3, Columns: 300 } }, true));
  add(
    unsupported,
    'decode-parms',
    register(doc, rasterBytes(300, 200, 3, false), { ...base, Width: 300, Height: 200, ColorSpace: 'DeviceRGB', DecodeParms: { Predictor: 2, Colors: 3, Columns: 300 } }, true),
  );

  add(
    supported,
    'flate-png-predictor',
    register(doc, rasterBytes(1500, 1000, 3, true), { ...base, Width: 1500, Height: 1000, ColorSpace: 'DeviceRGB', DecodeParms: { Predictor: 15, Colors: 3, Columns: 1500 } }, true),
  );
  add(supported, 'flate-gray', register(doc, rasterBytes(1500, 1000, 1, false), { ...base, Width: 1500, Height: 1000, ColorSpace: 'DeviceGray' }, true));
  add(supported, 'uncompressed-rgb', register(doc, rasterBytes(600, 400, 3, false), { ...base, Width: 600, Height: 400, ColorSpace: 'DeviceRGB' }, false));

  const unreferenced = register(doc, new Uint8Array(20000).fill(1), {}, false);
  const plain = new TextEncoder().encode('q 0 0 1 rg 10 10 50 50 re f Q\n'.repeat(400));
  const plainRef = register(doc, plain, {}, false);
  page.node.addContentStream(plainRef);

  return {
    bytes: await save(doc),
    unsupported,
    supported,
    unreferencedObject: unreferenced.objectNumber,
    plainContentObject: plainRef.objectNumber,
  };
}

export async function encryptedPdf(userPassword: string): Promise<Uint8Array> {
  const { doc } = await newDocWithText();
  doc.encrypt({ userPassword, ownerPassword: 'eigentuemer' });
  return doc.save({ useObjectStreams: false });
}

export { PDFDocument };
