import { describe, expect, it } from 'vitest';
import { PDFDocument } from '@cantoo/pdf-lib';
import { collectImages } from '../../../src/lib/pdf/document';
import { readJpegFrame, stripJpegApp1 } from '../../../src/lib/pdf/jpeg';
import { computePlacements, multiply, scanContent } from '../../../src/lib/pdf/placement';
import { PDF_PRESETS } from '../../../src/lib/pdf/presets';
import { computeScale, targetSize } from '../../../src/lib/pdf/recode';
import { deflate, inflate, undoPngPredictor } from '../../../src/lib/pdf/streams';
import { mixedPdf, rasterBytes } from './fixtures';
import { bytesEqual, jpegBytes } from './helpers';

describe('Streams', () => {
  it('kehrt PNG-Predictoren (alle fünf Filtertypen) exakt um', () => {
    const plain = rasterBytes(37, 23, 3, false);
    const filtered = rasterBytes(37, 23, 3, true);
    expect(bytesEqual(undoPngPredictor(filtered, 37, 23, 3)!, plain)).toBe(true);
    expect(undoPngPredictor(filtered.subarray(0, 10), 37, 23, 3)).toBeNull();
  });

  it('deflate/inflate sind verlustfrei; inflate begrenzt die Ausgabe', async () => {
    const data = new TextEncoder().encode('abc'.repeat(10_000));
    const packed = await deflate(data);
    expect(packed.length).toBeLessThan(data.length / 10);
    const full = await inflate(packed, data.length);
    expect(full.complete).toBe(true);
    expect(bytesEqual(full.bytes, data)).toBe(true);
    const capped = await inflate(packed, 100);
    expect(capped.bytes.length).toBe(100);
    expect(capped.complete).toBe(false);
  });
});

describe('JPEG', () => {
  it('liest SOF und entfernt APP1 (EXIF) verlustfrei', async () => {
    const jpeg = await jpegBytes(64, 48);
    expect(readJpegFrame(jpeg)).toMatchObject({ width: 64, height: 48, components: 3, precision: 8 });
    const exif = new Uint8Array([0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);
    const withExif = new Uint8Array(jpeg.length + exif.length);
    withExif.set(jpeg.subarray(0, 2));
    withExif.set(exif, 2);
    withExif.set(jpeg.subarray(2), 2 + exif.length);
    const stripped = stripJpegApp1(withExif);
    expect(stripped.length).toBeLessThanOrEqual(jpeg.length);
    expect(readJpegFrame(stripped)).toMatchObject({ width: 64, height: 48 });
    expect(stripJpegApp1(new Uint8Array([1, 2, 3]))).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe('Darstellungsgröße', () => {
  it('multipliziert Matrizen in PDF-Reihenfolge', () => {
    expect(multiply([2, 0, 0, 2, 0, 0], [1, 0, 0, 1, 10, 20])).toEqual([2, 0, 0, 2, 10, 20]);
    expect(multiply([1, 0, 0, 1, 10, 20], [2, 0, 0, 2, 0, 0])).toEqual([2, 0, 0, 2, 20, 40]);
  });

  it('scannt Operatoren und überspringt Strings, Kommentare und Inline-Bilder', () => {
    const src = 'q 1 0 0 1 5 5 cm (Do q) Tj % Do\nBI /W 2 /H 1 ID \x00EI\x01 EI Q /Im1 Do';
    const ops: string[] = [];
    scanContent(new TextEncoder().encode(src), (op, operands) => {
      ops.push(op === 'Do' ? `Do:${JSON.stringify(operands.at(-1))}` : op);
    });
    expect(ops).toEqual(['q', 'cm', 'Tj', 'Q', 'Do:{"name":"Im1"}']);
  });

  it('ermittelt die größte Darstellung je Bild', async () => {
    const { bytes, jpegPt } = await mixedPdf();
    const doc = await PDFDocument.load(bytes);
    const placements = computePlacements(doc);
    const jpeg = collectImages(doc.context).images.find((i) => i.filter === 'dct')!;
    const p = placements.get(jpeg.ref)!;
    expect(p.widthPt).toBeCloseTo(jpegPt.width, 3);
    expect(p.heightPt).toBeCloseTo(jpegPt.height, 3);
    expect(placements.size).toBe(3);
  });

  it('berechnet Skalierungsfaktoren aus DPI, Kantenbegrenzung und Mindeständerung', () => {
    const placement = { widthPt: 72 * 4, heightPt: 72 * 3 }; // 4 × 3 Zoll
    // 2400 px auf 4 Zoll = 600 dpi -> 150 dpi = Faktor 0,25
    expect(computeScale(2400, 1800, placement, PDF_PRESETS.balanced)).toBeCloseTo(0.25);
    // ohne Darstellung nur Kantenbegrenzung: 2000 / 4000
    expect(computeScale(4000, 1000, undefined, PDF_PRESETS.balanced)).toBeCloseTo(0.5);
    // 1250 px auf 4 Zoll = 312 dpi; high (300 dpi) wäre Faktor 0,96 -> keine Neuabtastung
    expect(computeScale(1250, 938, placement, PDF_PRESETS.high)).toBe(1);
    // nie vergrößern
    expect(computeScale(100, 100, placement, PDF_PRESETS.high)).toBe(1);
    expect(targetSize(2400, 1800, 0.25)).toEqual({ width: 600, height: 450 });
    expect(targetSize(3, 1, 0.1)).toEqual({ width: 1, height: 1 });
  });
});
