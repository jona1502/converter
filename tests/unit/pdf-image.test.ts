import { PDFDocument } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/lib/api/client';
import {
  buildPdfImageOptions,
  checkPdfFile,
  DEFAULT_PDF_IMAGE_SETTINGS,
  normalizePageSelection,
  parsePageSelection,
  pdfImageMessage,
  PDF_IMAGE_LIMITS,
  resolvePages,
  resultKind,
} from '../../src/lib/pdf-image';

describe('Seitenauswahl', () => {
  it('liest Einzelseiten und Bereiche sortiert und ohne Duplikate', () => {
    expect(parsePageSelection('3, 1,2')).toEqual({ ok: true, pages: [1, 2, 3] });
    expect(parsePageSelection('1-3, 2-5')).toEqual({ ok: true, pages: [1, 2, 3, 4, 5] });
    expect(parsePageSelection(' 7 - 8 ,7')).toEqual({ ok: true, pages: [7, 8] });
    expect(parsePageSelection('10-10')).toEqual({ ok: true, pages: [10] });
  });
  it('lehnt Unfertiges, Leeres und Ungültiges mit Grund ab', () => {
    for (const text of ['', '   ', ',', '1,', ',1', '1,,2']) expect(parsePageSelection(text)).toMatchObject({ ok: false, reason: 'syntax' });
    for (const text of ['a', '1-', '-3', '1--2', '1.5', '٣', '1e3', 'all']) expect(parsePageSelection(text)).toMatchObject({ ok: false, reason: 'syntax' });
    for (const text of ['0', '3-1', '0-2', '10000']) expect(parsePageSelection(text)).toMatchObject({ ok: false, reason: 'range' });
  });
  it('prüft gegen die Seitenzahl des Dokuments und die Obergrenze', () => {
    expect(parsePageSelection('1-5', { pageCount: 5 })).toEqual({ ok: true, pages: [1, 2, 3, 4, 5] });
    expect(parsePageSelection('4-6', { pageCount: 5 })).toMatchObject({ ok: false, reason: 'beyond' });
    expect(parsePageSelection('1-101')).toMatchObject({ ok: false, reason: 'too-many' });
    expect(parsePageSelection('1-100')).toMatchObject({ ok: true });
    expect(parsePageSelection('1-3', { maxPages: 2 })).toMatchObject({ ok: false, reason: 'too-many' });
  });
  it('schreibt kanonisch wie der Server', () => {
    expect(normalizePageSelection([1])).toBe('1');
    expect(normalizePageSelection([1, 2, 3, 5])).toBe('1-3,5');
    expect(normalizePageSelection([1, 3, 5])).toBe('1,3,5');
    expect(normalizePageSelection([1, 2, 4, 5, 6, 9])).toBe('1-2,4-6,9');
  });
});

describe('Optionen für den Server', () => {
  it('sendet immer vollständige Optionen, Standard sind PNG, 150 dpi und alle Seiten', () => {
    expect(buildPdfImageOptions(DEFAULT_PDF_IMAGE_SETTINGS)).toEqual({ tool: 'pdf-to-image', format: 'png', dpi: 150, pages: 'all' });
    expect(buildPdfImageOptions({ format: 'webp', dpi: 300, mode: 'selection', selection: '5,3,4' })).toEqual({ tool: 'pdf-to-image', format: 'webp', dpi: 300, pages: '3-5' });
  });
  it('fordert bei einseitigen PDFs ein Bild statt eines Archivs an', () => {
    expect(buildPdfImageOptions(DEFAULT_PDF_IMAGE_SETTINGS, 1).pages).toBe('1');
    expect(buildPdfImageOptions(DEFAULT_PDF_IMAGE_SETTINGS, 2).pages).toBe('all');
  });
  it('wirft bei ungültiger Auswahl, damit nie ein falscher Auftrag entsteht', () => {
    expect(() => buildPdfImageOptions({ ...DEFAULT_PDF_IMAGE_SETTINGS, mode: 'selection', selection: '3-1' })).toThrow();
  });
  it('löst die Auswahl für die Anzeige auf', () => {
    expect(resolvePages({ ...DEFAULT_PDF_IMAGE_SETTINGS }, 3)).toEqual({ ok: true, pages: [1, 2, 3] });
    expect(resolvePages({ ...DEFAULT_PDF_IMAGE_SETTINGS }, 101)).toMatchObject({ ok: false, reason: 'too-many' });
    expect(resolvePages({ ...DEFAULT_PDF_IMAGE_SETTINGS }, undefined)).toEqual({ ok: true, pages: undefined });
    expect(resolvePages({ ...DEFAULT_PDF_IMAGE_SETTINGS, mode: 'selection', selection: '2' }, 3)).toEqual({ ok: true, pages: [2] });
  });
  it('unterscheidet Bild und Archiv wie der Server', () => {
    expect(resultKind({ ...DEFAULT_PDF_IMAGE_SETTINGS, mode: 'selection', selection: '4' }, 9)).toBe('image');
    expect(resultKind({ ...DEFAULT_PDF_IMAGE_SETTINGS, mode: 'selection', selection: '1-2' }, 9)).toBe('archive');
    expect(resultKind(DEFAULT_PDF_IMAGE_SETTINGS, 9)).toBe('archive');
    expect(resultKind(DEFAULT_PDF_IMAGE_SETTINGS, 1)).toBe('image');
  });
});

async function pdfWithPages(count: number): Promise<Uint8Array<ArrayBuffer>> {
  const doc = await PDFDocument.create();
  for (let page = 0; page < count; page++) doc.addPage([10, 10]);
  return new Uint8Array(await doc.save());
}

describe('PDF-Vorprüfung ohne Upload', () => {
  it('liest die Seitenzahl lokal', async () => {
    expect(await checkPdfFile(new File([await pdfWithPages(2)], 'a.pdf'))).toEqual({ ok: true, pageCount: 2 });
  });
  it('lehnt Größe und Nicht-PDF vor dem Lesen ab', async () => {
    expect(await checkPdfFile(new File(['12345'], 'a.pdf'), 4)).toEqual({ ok: false, code: 'file-too-large' });
    expect(await checkPdfFile(new File(['Hallo'], 'a.pdf'))).toEqual({ ok: false, code: 'not-pdf' });
    expect(await checkPdfFile(new File([], 'a.pdf'))).toEqual({ ok: false, code: 'not-pdf' });
  });
  it('lässt unlesbare, aber als PDF erkennbare Dateien zur Prüfung auf dem Server zu', async () => {
    expect(await checkPdfFile(new File(['%PDF-1.7\nkaputt'], 'a.pdf'))).toEqual({ ok: true, pageCount: undefined });
  });
});

describe('Fehlertexte', () => {
  it('erklärt die Fehler dieses Werkzeugs konkret', () => {
    const text = (code: string) => pdfImageMessage(new ApiError(code));
    expect(text('encrypted')).toMatch(/Verschlüsselte/);
    expect(text('not-pdf')).toMatch(/PDF/);
    expect(text('parse-failed')).toMatch(/Seite|PDF/);
    expect(text('dimensions-too-large')).toMatch(/Megapixel/);
    expect(text('dimensions-too-large')).toMatch(/Auflösung/);
    expect(text('result-too-large')).toMatch(new RegExp(`${PDF_IMAGE_LIMITS.maxPages} Seiten`));
    expect(text('file-too-large')).toMatch(/100\sMB/);
    expect(text('service-unavailable')).toMatch(/nicht verfügbar/);
    expect(text('timeout')).toMatch(/Zeitlimit/);
  });
  it('fällt bei Unbekanntem auf die allgemeine Meldung zurück', () => {
    expect(pdfImageMessage(new Error('x'))).toMatch(/nicht erreichbar/);
  });
});
