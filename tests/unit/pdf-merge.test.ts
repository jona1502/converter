import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/lib/api/client';
import { buildPdfMergeOptions, checkPdfFile, moveItem, PDF_MERGE_LIMITS, pdfMergeLimits, pdfMergeMessage, selectionIssue } from '../../src/lib/pdfmerge';

describe('PDF-Vorprüfung ohne Upload', () => {
  it('akzeptiert eine Datei mit PDF-Signatur, auch mit Vorspann', async () => {
    expect(await checkPdfFile(new File(['%PDF-1.7\n'], 'a.pdf'))).toEqual({ ok: true });
    expect(await checkPdfFile(new File(['\n\n%PDF-1.4'], 'ohne-endung'))).toEqual({ ok: true });
  });
  it('weist Nicht-PDFs, leere und zu große Dateien zurück', async () => {
    expect(await checkPdfFile(new File(['GIF89a'], 'a.pdf'))).toEqual({ ok: false, code: 'not-pdf' });
    expect(await checkPdfFile(new File([], 'a.pdf'))).toEqual({ ok: false, code: 'unsupported-type' });
    expect(await checkPdfFile(new File(['%PDF-1.7 12345'], 'a.pdf'), 5)).toEqual({ ok: false, code: 'file-too-large' });
  });
  it('sucht die Signatur nur in den ersten 1024 Bytes', async () => {
    expect(await checkPdfFile(new File([' '.repeat(2000), '%PDF-'], 'a.pdf'))).toEqual({ ok: false, code: 'not-pdf' });
  });
});

describe('Reihenfolge', () => {
  it('verschiebt Elemente ohne die Eingabe zu verändern', () => {
    const items = ['a', 'b', 'c'];
    expect(moveItem(items, 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(items, 2, -1)).toEqual(['a', 'c', 'b']);
    expect(items).toEqual(['a', 'b', 'c']);
  });
  it('ignoriert Bewegungen über die Ränder hinaus', () => {
    expect(moveItem(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    expect(moveItem(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
    expect(moveItem(['a', 'b'], 5, -1)).toEqual(['a', 'b']);
  });
});

describe('Auswahlgrenzen', () => {
  it('verlangt zwei bis zwanzig Dateien und eine Gesamtgröße', () => {
    expect(selectionIssue([1], PDF_MERGE_LIMITS)).toMatch(/mindestens 2/);
    expect(selectionIssue([1, 1], PDF_MERGE_LIMITS)).toBeNull();
    expect(selectionIssue(Array(20).fill(1), PDF_MERGE_LIMITS)).toBeNull();
    expect(selectionIssue(Array(21).fill(1), PDF_MERGE_LIMITS)).toMatch(/höchstens 20/);
    expect(selectionIssue([60_000_000, 40_000_000], PDF_MERGE_LIMITS)).toBeNull();
    expect(selectionIssue([60_000_000, 40_000_001], PDF_MERGE_LIMITS)).toMatch(/zusammen/);
  });
  it('übernimmt die vom Server gemeldeten Grenzen', () => {
    const limits = pdfMergeLimits({ available: true, minFiles: 2, maxFiles: 5, maxTotalBytes: 10, maxOutputBytes: 11, maxPages: 12 });
    expect(limits).toEqual({ minFiles: 2, maxFiles: 5, maxTotalBytes: 10, maxOutputBytes: 11, maxPages: 12 });
    expect(selectionIssue([1, 1, 1, 1, 1, 1], limits)).toMatch(/höchstens 5/);
  });
});

describe('Optionen und Meldungen', () => {
  it('sendet nur das Werkzeug', () => {
    expect(buildPdfMergeOptions()).toEqual({ tool: 'pdf-merge' });
  });
  it('erklärt Serverfehler auf Deutsch', () => {
    expect(pdfMergeMessage(new ApiError('encrypted'))).toMatch(/verschlüsselt/);
    expect(pdfMergeMessage(new ApiError('not-pdf'))).toMatch(/keine erkennbare PDF/);
    expect(pdfMergeMessage(new ApiError('parse-failed'))).toMatch(/beschädigt/);
    expect(pdfMergeMessage(new ApiError('file-too-large'))).toMatch(/100\sMB/);
    expect(pdfMergeMessage(new ApiError('dimensions-too-large'))).toMatch(/2000 Seiten/);
    expect(pdfMergeMessage(new ApiError('result-too-large'))).toMatch(/zusammengeführte PDF/);
    expect(pdfMergeMessage(new ApiError('service-unavailable'))).toMatch(/verfügbar/);
    expect(pdfMergeMessage(new TypeError('x'))).toMatch(/nicht erreichbar/);
  });
});
