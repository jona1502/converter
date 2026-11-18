import { describe, expect, it } from 'vitest';
import vectors from '../../api/page-range-vectors.json';
import { ApiError } from '../../src/lib/api/client';
import {
  buildSplitOptions, checkSplitSettings, describePart, MAX_PAGE_NUMBER, MAX_RANGES, MAX_RANGES_LENGTH,
  parsePageRanges, splitMessage,
} from '../../src/lib/pdfSplit';

describe('Seitenbereichs-Syntax (gemeinsame Vektoren mit Go und Python)', () => {
  it('verwendet dieselben Grenzen', () => {
    expect(MAX_PAGE_NUMBER).toBe(vectors.maxPageNumber);
    expect(MAX_RANGES).toBe(vectors.maxRanges);
    expect(MAX_RANGES_LENGTH).toBe(vectors.maxLength);
  });
  it('akzeptiert alle gültigen Vektoren mit identischem Ergebnis', () => {
    for (const { input, ranges } of vectors.valid) {
      const parsed = parsePageRanges(input);
      expect(parsed.ok, input).toBe(true);
      if (parsed.ok) expect(parsed.ranges.map((r) => [r.start, r.end]), input).toEqual(ranges);
    }
  });
  it('lehnt alle ungültigen Vektoren ab', () => {
    for (const input of vectors.invalid) expect(parsePageRanges(input).ok, JSON.stringify(input)).toBe(false);
  });
  it('begrenzt Anzahl und Länge', () => {
    expect(parsePageRanges(Array(MAX_RANGES).fill('1').join(',')).ok).toBe(true);
    expect(parsePageRanges(Array(MAX_RANGES + 1).fill('1').join(',')).ok).toBe(false);
    expect(parsePageRanges('1-' + '0'.repeat(MAX_RANGES_LENGTH)).ok).toBe(false);
  });
  it('nennt die Ursache und den fehlerhaften Bereich', () => {
    expect(parsePageRanges('')).toMatchObject({ ok: false, problem: 'empty' });
    expect(parsePageRanges('1, 2')).toMatchObject({ ok: false, problem: 'whitespace', item: 1 });
    expect(parsePageRanges('1,x')).toMatchObject({ ok: false, problem: 'syntax', item: 1 });
    expect(parsePageRanges('1,03')).toMatchObject({ ok: false, problem: 'zero', item: 1 });
    expect(parsePageRanges('0')).toMatchObject({ ok: false, problem: 'zero' });
    expect(parsePageRanges('5-2')).toMatchObject({ ok: false, problem: 'descending' });
    expect(parsePageRanges('1-100000')).toMatchObject({ ok: false, problem: 'too-large' });
  });
});

describe('Einstellungen prüfen', () => {
  it('liefert Teilezahl und ZIP-Entscheidung wie der Server', () => {
    expect(checkSplitSettings({ mode: 'ranges', ranges: '2-4' }, 10)).toEqual({ ok: true, parts: 1, zip: false });
    expect(checkSplitSettings({ mode: 'ranges', ranges: '7-' }, 10)).toEqual({ ok: true, parts: 1, zip: false });
    expect(checkSplitSettings({ mode: 'ranges', ranges: '1-3,5' }, 10)).toEqual({ ok: true, parts: 2, zip: true });
    expect(checkSplitSettings({ mode: 'each', ranges: '' }, 3)).toEqual({ ok: true, parts: 3, zip: true });
    expect(checkSplitSettings({ mode: 'each', ranges: '' }, null)).toEqual({ ok: true, parts: null, zip: true });
  });
  it('prüft Bereiche gegen die Seitenzahl, wenn sie bekannt ist', () => {
    expect(checkSplitSettings({ mode: 'ranges', ranges: '1-3,11' }, 10)).toMatchObject({ ok: false, message: expect.stringContaining('Bereich 2') });
    expect(checkSplitSettings({ mode: 'ranges', ranges: '11-' }, 10)).toMatchObject({ ok: false });
    expect(checkSplitSettings({ mode: 'ranges', ranges: '1-11' }, 10)).toMatchObject({ ok: false });
    expect(checkSplitSettings({ mode: 'ranges', ranges: '1-11' }, null)).toMatchObject({ ok: true });
    expect(checkSplitSettings({ mode: 'ranges', ranges: '1' }, 1)).toMatchObject({ ok: true });
  });
  it('lehnt je Seite einzeln oberhalb der Teilegrenze ab', () => {
    expect(checkSplitSettings({ mode: 'each', ranges: '' }, 501)).toMatchObject({ ok: false });
    expect(checkSplitSettings({ mode: 'each', ranges: '' }, 500)).toMatchObject({ ok: true });
  });
  it('erklärt Syntaxfehler auf Deutsch', () => {
    expect(checkSplitSettings({ mode: 'ranges', ranges: '1, 2' }, null)).toMatchObject({ ok: false, message: expect.stringMatching(/Leerzeichen/) });
    expect(checkSplitSettings({ mode: 'ranges', ranges: '' }, null)).toMatchObject({ ok: false });
  });
});

describe('Optionen und Meldungen', () => {
  it('baut genau die API-Optionen', () => {
    expect(buildSplitOptions({ mode: 'each', ranges: '1-3' })).toEqual({ tool: 'pdf-split', mode: 'each' });
    expect(buildSplitOptions({ mode: 'ranges', ranges: '1-3,5' })).toEqual({ tool: 'pdf-split', mode: 'ranges', ranges: '1-3,5' });
  });
  it('beschreibt Teile', () => {
    expect(describePart({ start: 5, end: 5 })).toBe('Seite 5');
    expect(describePart({ start: 1, end: 3 })).toBe('Seiten 1–3');
    expect(describePart({ start: 7, end: null })).toBe('Seiten 7 bis zum Ende');
  });
  it('übersetzt Serverfehler', () => {
    expect(splitMessage(new ApiError('page-range-invalid'))).toMatch(/Seitenbereiche/);
    expect(splitMessage(new ApiError('encrypted'))).toMatch(/Verschlüsselte/);
    expect(splitMessage(new ApiError('file-too-large'))).toMatch(/zu groß/);
    expect(splitMessage(new ApiError('result-too-large'))).toMatch(/überschreitet/);
    expect(splitMessage(new ApiError('service-unavailable'))).toMatch(/verfügbar/);
  });
});
