import { beforeAll, describe, expect, it } from 'vitest';
import { PDFHeader, PDFRef } from '@cantoo/pdf-lib';
import { compressPdfBytes, type CompressOutput, type CompressPhase } from '../../../src/lib/pdf/compress';
import { PdfProcessingError, PDF_QUALITY_LEVELS, type PdfErrorCode, type PdfQualityLevel } from '../../../src/lib/pdf/types';
import { encryptedPdf, mixedPdf, specialPdf, textOnlyPdf, type MixedPdf, type SpecialPdf } from './fixtures';
import { browserName, bytesEqual, fontNames, jpegBytes, listImages, newDocWithText, pageContentText, pageCount, PDFDocument, PDFName, PDFRawStream, TEXT } from './helpers';

async function codeOf(promise: Promise<unknown>): Promise<PdfErrorCode | 'resolved'> {
  try {
    await promise;
    return 'resolved';
  } catch (e) {
    if (e instanceof PdfProcessingError) return e.code;
    throw e;
  }
}

const textHex = Array.from(new TextEncoder().encode(TEXT), (b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');

async function expectTextPreserved(bytes: Uint8Array): Promise<void> {
  const content = await pageContentText(bytes);
  expect(content).toMatch(/\bTj\b|\bTJ\b/);
  expect(content.toUpperCase()).toContain(textHex);
  expect(content).toContain('200 40 l'); // Rechteckpfad (Vektor)
  expect(await fontNames(bytes)).toContain('Helvetica');
}

describe('compressPdfBytes – gemischtes Dokument', () => {
  let fixture: MixedPdf;
  const outputs = new Map<PdfQualityLevel, CompressOutput>();

  beforeAll(async () => {
    fixture = await mixedPdf();
    for (const level of PDF_QUALITY_LEVELS) outputs.set(level, await compressPdfBytes(fixture.bytes, level));
  }, 120_000);

  it('liefert gültige PDFs mit gleicher Seitenzahl, Text, Schrift und Vektorgrafik', async () => {
    for (const level of PDF_QUALITY_LEVELS) {
      const out = outputs.get(level)!;
      expect(new TextDecoder().decode(out.bytes.subarray(0, 5))).toBe('%PDF-');
      expect(await pageCount(out.bytes)).toBe(2);
      await expectTextPreserved(out.bytes);
    }
  });

  it('verkleinert Bildpixel und hält die Stufen monoton (small ≤ balanced ≤ high)', async () => {
    const original = await listImages(fixture.bytes);
    const jpegOriginal = original.find((i) => i.filter === 'DCTDecode')!;
    expect(jpegOriginal.width).toBe(2400);

    const imageBytes = new Map<PdfQualityLevel, number>();
    const jpegWidth = new Map<PdfQualityLevel, number>();
    for (const level of PDF_QUALITY_LEVELS) {
      const images = await listImages(outputs.get(level)!.bytes);
      expect(images.length).toBe(original.length);
      imageBytes.set(level, images.reduce((s, i) => s + i.length, 0));
      const jpeg = images.find((i) => i.objectNumber === jpegOriginal.objectNumber)!;
      expect(jpeg.filter).toBe('DCTDecode');
      jpegWidth.set(level, jpeg.width);
    }
    // Darstellung 500 pt breit: 300/150/100 dpi -> 2083/1042/694 px.
    expect(jpegWidth.get('high')).toBe(2083);
    expect(jpegWidth.get('balanced')).toBe(1042);
    expect(jpegWidth.get('small')).toBe(694);
    expect(imageBytes.get('small')!).toBeLessThanOrEqual(imageBytes.get('balanced')!);
    expect(imageBytes.get('balanced')!).toBeLessThanOrEqual(imageBytes.get('high')!);

    const small = await listImages(outputs.get('small')!.bytes);
    for (const image of original.filter((i) => !i.isMask && i.width !== 600)) {
      const after = small.find((i) => i.objectNumber === image.objectNumber)!;
      expect(after.width).toBeLessThan(image.width);
      expect(after.height).toBeLessThan(image.height);
    }

    const sizes = PDF_QUALITY_LEVELS.map((l) => `${l}=${outputs.get(l)!.bytes.length}`).join(' ');
    const imgs = PDF_QUALITY_LEVELS.map((l) => `${l}=${imageBytes.get(l)}`).join(' ');
    console.info(`[pdf-messung ${browserName()}] Original ${fixture.bytes.length} B (Bilder ${original.reduce((s, i) => s + i.length, 0)} B); Ergebnis ${sizes}; Bildbytes ${imgs}`);
  });

  it('erhält maskierte Bilder und ihre Soft-Mask byte-identisch', async () => {
    const original = await listImages(fixture.bytes);
    const small = await listImages(outputs.get('small')!.bytes);
    for (const image of original.filter((i) => i.isMask || i.width === 600)) {
      const after = small.find((i) => i.objectNumber === image.objectNumber)!;
      expect(after.width).toBe(image.width);
      expect(after.height).toBe(image.height);
      expect(bytesEqual(after.contents, image.contents)).toBe(true);
    }
  });

  it('meldet Zähler und Hinweise ehrlich', () => {
    const small = outputs.get('small')!.stats;
    expect(small.imagesRecompressed).toBe(2);
    expect(small.imagesResized).toBe(2);
    expect(small.imagesSkipped).toBe(1);
    const high = outputs.get('high')!.stats;
    expect(high.imagesRecompressed + high.imagesNotSmaller + high.imagesSkipped).toBe(3);
    expect(small.notes.find((n) => n.code === 'image-size-unknown')).toBeUndefined();
  });
});

describe('compressPdfBytes – Sonderfälle', () => {
  let fixture: SpecialPdf;
  let out: CompressOutput;

  beforeAll(async () => {
    fixture = await specialPdf();
    out = await compressPdfBytes(fixture.bytes, 'small');
  }, 120_000);

  it('lässt nicht unterstützte Bilder byte-identisch', async () => {
    const before = await listImages(fixture.bytes);
    const after = await listImages(out.bytes);
    for (const [num] of fixture.unsupported) {
      const a = before.find((i) => i.objectNumber === num)!;
      const b = after.find((i) => i.objectNumber === num)!;
      expect(b, `Bild ${num}`).toBeDefined();
      expect(bytesEqual(a.contents, b.contents), `Bild ${num}`).toBe(true);
      expect(b.width).toBe(a.width);
      expect(b.filter).toBe(a.filter);
    }
    expect(out.stats.imagesSkipped).toBe(fixture.unsupported.size);
  });

  it('kodiert Flate mit PNG-Predictor, Graustufen und unkomprimierte Bilder neu', async () => {
    const after = await listImages(out.bytes);
    for (const [num, label] of fixture.supported) {
      const b = after.find((i) => i.objectNumber === num)!;
      expect(b.filter, label).toBe('DCTDecode');
      expect(b.colorSpace, label).toBe('DeviceRGB');
      expect(b.width, label).toBeLessThan(700);
    }
    expect(out.stats.imagesRecompressed).toBe(fixture.supported.size);
  });

  it('dekodiert den PNG-Predictor korrekt (Pixelvergleich nach Neukodierung)', async () => {
    const out2 = await compressPdfBytes(fixture.bytes, 'high');
    const num = [...fixture.supported].find(([, l]) => l === 'flate-png-predictor')![0];
    const image = (await listImages(out2.bytes)).find((i) => i.objectNumber === num)!;
    const bitmap = await createImageBitmap(new Blob([image.contents as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    // Erwartet: horizontaler Verlauf (links dunkel, rechts hell) – bei falscher Predictor-Umkehr entsteht Rauschen.
    const y = Math.floor(bitmap.height / 2);
    const left = ctx.getImageData(2, y, 1, 1).data[0]!;
    const right = ctx.getImageData(bitmap.width - 3, y, 1, 1).data[0]!;
    expect(right - left).toBeGreaterThan(150);
    bitmap.close();
  });

  it('entfernt unreferenzierte Objekte und komprimiert unkomprimierte Streams verlustfrei', async () => {
    const doc = await PDFDocument.load(out.bytes, { updateMetadata: false });
    expect(doc.context.lookup(PDFRef.of(fixture.unreferencedObject))).toBeUndefined();
    const plain = doc.context.lookup(PDFRef.of(fixture.plainContentObject));
    expect(plain).toBeInstanceOf(PDFRawStream);
    expect((plain as PDFRawStream).dict.get(PDFName.of('Filter'))).toBe(PDFName.of('FlateDecode'));
    expect(out.stats.objectsRemoved).toBeGreaterThanOrEqual(1);
    expect(out.stats.streamsCompressed).toBeGreaterThanOrEqual(1);
    const content = await pageContentText(out.bytes);
    expect(content).toContain('q 0 0 1 rg 10 10 50 50 re f Q');
  });
});

describe('compressPdfBytes – reine Text-PDF und Fehler', () => {
  it('liefert für eine reine Text-PDF ein gültiges Ergebnis mit echter Größe', async () => {
    const bytes = await textOnlyPdf();
    const out = await compressPdfBytes(bytes, 'small');
    expect(await pageCount(out.bytes)).toBe(1);
    await expectTextPreserved(out.bytes);
    expect(out.stats.imagesRecompressed).toBe(0);
    console.info(`[pdf-messung ${browserName()}] Text-PDF: Original ${bytes.length} B, Ergebnis ${out.bytes.length} B`);
  });

  it('meldet die Phasen in Reihenfolge mit echten Zählern', async () => {
    const { bytes } = await mixedPdf();
    const events: { phase: CompressPhase; current?: number; total?: number }[] = [];
    await compressPdfBytes(bytes, 'balanced', { onPhase: (phase, current, total) => events.push({ phase, current, total }) });
    expect(events[0]!.phase).toBe('loading');
    expect(events[events.length - 1]!.phase).toBe('saving');
    const images = events.filter((e) => e.phase === 'images');
    expect(images.map((e) => e.current)).toEqual([0, 1, 2, 3]);
    expect(images.every((e) => e.total === 3)).toBe(true);
  });

  it('lehnt beschädigte, verschlüsselte Dateien und unbekannte Stufen mit Codes ab', async () => {
    const garbage = new TextEncoder().encode('%PDF-1.7\n' + 'kaputt '.repeat(200));
    expect(await codeOf(compressPdfBytes(garbage, 'small'))).toBe('parse-failed');
    expect(await codeOf(compressPdfBytes(await encryptedPdf('geheim'), 'small'))).toBe('encrypted');
    expect(await codeOf(compressPdfBytes(await encryptedPdf(''), 'small'))).toBe('encrypted');
    expect(await codeOf(compressPdfBytes(await textOnlyPdf(), 'mittel' as PdfQualityLevel))).toBe('invalid-options');
  }, 60_000); // Zwei AES-256-Fixtures benötigen unter Last mehr als den Standard-Timeout.
});

describe('compressPdfBytes – Dateistruktur', () => {
  it('verarbeitet Eingaben mit Objekt-Streams', async () => {
    const { doc } = await newDocWithText();
    const image = await doc.embedJpg(await jpegBytes(1200, 900, 0.95));
    doc.getPage(0).drawImage(image, { x: 0, y: 0, width: 300, height: 225 });
    const out = await compressPdfBytes(await doc.save({ useObjectStreams: true }), 'balanced');
    expect(await pageCount(out.bytes)).toBe(1);
    await expectTextPreserved(out.bytes);
    expect(out.stats.imagesResized).toBe(1);
  });

  it('hebt PDF 1.4 für Objekt-Streams auf 1.7 an und meldet es', async () => {
    const { doc } = await newDocWithText();
    doc.context.header = PDFHeader.forVersion(1, 4);
    const input = await doc.save({ useObjectStreams: false });
    expect(new TextDecoder().decode(input.subarray(0, 8))).toBe('%PDF-1.4');
    const out = await compressPdfBytes(input, 'high');
    expect(new TextDecoder().decode(out.bytes.subarray(0, 8))).toBe('%PDF-1.7');
    expect(out.stats.notes).toContainEqual({ code: 'pdf-version-raised' });
  });
});
