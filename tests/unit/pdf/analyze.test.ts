import { describe, expect, it } from 'vitest';
import { analyzePdfBytes } from '../../../src/lib/pdf/analyze';
import { checkFileSize, findPdfSignature, readFileBytes } from '../../../src/lib/pdf/document';
import { PDF_LIMITS } from '../../../src/lib/pdf/limits';
import { PdfProcessingError, type PdfErrorCode } from '../../../src/lib/pdf/types';
import { encryptedPdf, mixedPdf, specialPdf, textOnlyPdf } from './fixtures';
import { jpegBytes, toFile } from './helpers';

async function codeOf(promise: Promise<unknown>): Promise<PdfErrorCode | 'resolved'> {
  try {
    await promise;
    return 'resolved';
  } catch (e) {
    if (e instanceof PdfProcessingError) return e.code;
    throw e;
  }
}

describe('analyzePdfBytes', () => {
  it('erkennt Seiten, Bildarten, Masken und deren Bytes', async () => {
    const { bytes } = await mixedPdf();
    const a = await analyzePdfBytes(bytes);
    expect(a.fileSize).toBe(bytes.length);
    expect(a.pageCount).toBe(2);
    expect(a.encrypted).toBe(false);
    expect(a.images.total).toBe(3);
    expect(a.images.recompressible).toBe(2);
    expect(a.images.byFilter).toEqual({ dct: 1, flate: 2, none: 0, other: 0 });
    expect(a.images.maskCount).toBe(1);
    expect(a.images.bytes).toBeGreaterThan(a.images.recompressibleBytes);
    expect(a.images.recompressibleBytes).toBeGreaterThan(100_000);
    expect(a.fontBytes).toBe(0); // Standardschrift, nicht eingebettet
    expect(a.images.skipped).toEqual({ mask: 1 });
    expect(a.limitations).toEqual([{ code: 'images-not-recompressible', count: 1 }]);
  });

  it('meldet bei einer reinen Text-PDF die Grenze „keine Bilder“', async () => {
    const a = await analyzePdfBytes(await textOnlyPdf());
    expect(a.images.total).toBe(0);
    expect(a.limitations.map((l) => l.code)).toEqual(['no-images']);
  });

  it('zählt nicht neu kodierbare Bilder nach Grund', async () => {
    const fixture = await specialPdf();
    const a = await analyzePdfBytes(fixture.bytes);
    expect(a.images.total).toBe(fixture.unsupported.size + fixture.supported.size);
    expect(a.images.recompressible).toBe(fixture.supported.size);
    const expected: Record<string, number> = {};
    for (const reason of fixture.unsupported.values()) expected[reason] = (expected[reason] ?? 0) + 1;
    expect(a.images.skipped).toEqual(expected);
    expect(a.limitations).toContainEqual({ code: 'images-not-recompressible', count: fixture.unsupported.size });
  });

  it('lehnt verschlüsselte PDFs ab – auch mit leerem Benutzerpasswort', async () => {
    expect(await codeOf(analyzePdfBytes(await encryptedPdf('geheim')))).toBe('encrypted');
    expect(await codeOf(analyzePdfBytes(await encryptedPdf('')))).toBe('encrypted');
  }, 60_000); // AES-256-Fixtures sind insbesondere in Firefox rechenintensiv.

  it('meldet beschädigte Dateien als parse-failed', async () => {
    const garbage = new TextEncoder().encode('%PDF-1.4\n1 0 obj << /Type /Catalog >> kaputt');
    expect(await codeOf(analyzePdfBytes(garbage))).toBe('parse-failed');
    const valid = await textOnlyPdf();
    expect(await codeOf(analyzePdfBytes(valid.subarray(0, 200)))).toBe('parse-failed');
  });
});

describe('Eingangsprüfung', () => {
  it('findet %PDF- nur in den ersten 1024 Bytes', () => {
    const enc = new TextEncoder();
    expect(findPdfSignature(enc.encode('%PDF-1.7'))).toBe(0);
    expect(findPdfSignature(enc.encode(' '.repeat(1000) + '%PDF-1.7'))).toBe(1000);
    expect(findPdfSignature(enc.encode(' '.repeat(1020) + '%PDF-1.7'))).toBe(-1);
    expect(findPdfSignature(enc.encode('%PDF'))).toBe(-1);
  });

  it('lehnt Nicht-PDFs anhand der Bytes ab, nicht anhand von Name oder Typ', async () => {
    const jpeg = await jpegBytes(20, 20);
    expect(await codeOf(readFileBytes(toFile(jpeg, 'tarnung.pdf')))).toBe('not-pdf');
    expect(await codeOf(readFileBytes(new Blob([])))).toBe('not-pdf');
  });

  it('prüft die Größe vor dem Lesen', async () => {
    expect(() => checkFileSize(PDF_LIMITS.maxFileBytes)).not.toThrow();
    expect(() => checkFileSize(PDF_LIMITS.maxFileBytes + 1)).toThrow(PdfProcessingError);
    const chunk = new Uint8Array(1_000_000);
    const big = new Blob([...Array<Uint8Array<ArrayBuffer>>(100).fill(chunk), new Uint8Array(1)]);
    expect(await codeOf(readFileBytes(big))).toBe('file-too-large');
  });
});
