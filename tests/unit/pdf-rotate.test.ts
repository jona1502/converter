import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/lib/api/client';
import {
  buildPdfRotateOptions,
  checkPdfRotateFile,
  DEFAULT_PDF_ROTATE_SETTINGS,
  describePdfRotateSettings,
  parsePdfPages,
  pdfRotateMessage,
} from '../../src/lib/pdf-rotate';

const pdf = (name = 'a.pdf', extra = '') => new File([`%PDF-1.7\n${extra}`], name, { type: 'application/pdf' });

describe('Seitenangabe', () => {
  it('akzeptiert einzelne Seiten, Bereiche und Listen und entfernt Leerzeichen', () => {
    expect(parsePdfPages('7')).toEqual({ ok: true, value: '7' });
    expect(parsePdfPages(' 1-3 , 5,9-10 ')).toEqual({ ok: true, value: '1-3,5,9-10' });
    expect(parsePdfPages('2–4')).toEqual({ ok: true, value: '2-4' });
  });
  it('weist leere, umgekehrte, nullbasierte und fehlerhafte Angaben mit Erklärung zurück', () => {
    for (const text of ['', '  ', '0', '3-1', '1,,2', '-2', '1-', 'a', '1-2-3', '01', '1.5', '12345678', '1'.repeat(300)]) {
      const result = parsePdfPages(text);
      expect(result.ok, text).toBe(false);
      if (!result.ok) expect(result.message).toMatch(/Seite|Bereich|Angabe/);
    }
  });
});

describe('Optionen für POST /jobs', () => {
  it('sendet immer vollständige Optionen, Standard ist 90° für alle Seiten', () => {
    expect(buildPdfRotateOptions(DEFAULT_PDF_ROTATE_SETTINGS)).toEqual({ tool: 'pdf-rotate', angle: 90, pages: 'all' });
    expect(buildPdfRotateOptions({ angle: 270, scope: 'all', pages: '1-2' })).toEqual({ tool: 'pdf-rotate', angle: 270, pages: 'all' });
    expect(buildPdfRotateOptions({ angle: 180, scope: 'range', pages: ' 1-3, 5 ' })).toEqual({ tool: 'pdf-rotate', angle: 180, pages: '1-3,5' });
  });
  it('wirft bei ungültiger Seitenangabe, statt etwas anderes zu senden', () => {
    expect(() => buildPdfRotateOptions({ angle: 90, scope: 'range', pages: '3-1' })).toThrow();
  });
  it('beschreibt die Einstellung für die Ergebnisanzeige', () => {
    expect(describePdfRotateSettings({ angle: 90, scope: 'all', pages: '' })).toBe('90° im Uhrzeigersinn, alle Seiten');
    expect(describePdfRotateSettings({ angle: 270, scope: 'range', pages: '1-3,5' })).toBe('270° im Uhrzeigersinn, Seiten 1-3,5');
  });
});

describe('PDF-Vorprüfung ohne Upload', () => {
  it('akzeptiert eine PDF mit Signatur', async () => {
    expect(await checkPdfRotateFile(pdf(), 1000)).toEqual({ ok: true });
    expect(await checkPdfRotateFile(new File(['xx%PDF-1.4'], 'scan.PDF'), 1000)).toEqual({ ok: true });
  });
  it('weist leere, zu große und Nicht-PDF-Dateien zurück', async () => {
    expect(await checkPdfRotateFile(new File([], 'a.pdf'), 1000)).toEqual({ ok: false, code: 'unsupported-type' });
    expect(await checkPdfRotateFile(pdf('a.pdf', 'x'.repeat(100)), 10)).toEqual({ ok: false, code: 'file-too-large' });
    expect(await checkPdfRotateFile(new File(['hello'], 'a.pdf'), 1000)).toEqual({ ok: false, code: 'not-pdf' });
  });
});

describe('Fehlermeldungen', () => {
  it('erklärt die Ursachen auf Deutsch', () => {
    expect(pdfRotateMessage(new ApiError('encrypted'))).toMatch(/Verschlüsselte/);
    expect(pdfRotateMessage(new ApiError('not-pdf'))).toMatch(/PDF/);
    expect(pdfRotateMessage(new ApiError('parse-failed'))).toMatch(/beschädigt/);
    expect(pdfRotateMessage(new ApiError('invalid-options'))).toMatch(/Seiten/);
    expect(pdfRotateMessage(new ApiError('result-too-large'))).toMatch(/gedrehte PDF/);
    expect(pdfRotateMessage(new ApiError('file-too-large'), { maxFileBytes: 2_000_000 })).toMatch(/2/);
  });
});
